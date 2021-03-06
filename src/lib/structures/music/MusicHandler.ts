import { SkyraClient } from '@lib/SkyraClient';
import { Events } from '@lib/types/Enums';
import { LavalinkPlayerEvents } from '@lib/types/Events';
import { GuildSettings } from '@lib/types/settings/GuildSettings';
import { flattenMusicHandler } from '@utils/Models/ApiTransform';
import { enumerable, fetch, FetchResultTypes } from '@utils/util';
import { Guild, TextChannel, VoiceChannel } from 'discord.js';
import { KlasaMessage } from 'klasa';
import { LoadType, TrackData, TrackResponse } from 'lavacord';
import { Song } from './Song';

export class MusicHandler {

	@enumerable(false)
	public client: SkyraClient;

	@enumerable(false)
	public guild: Guild;

	@enumerable(false)
	public channelID: string | null = null;

	@enumerable(false)
	public systemPaused = false;

	public queue: Song[] = [];
	public volume = 100;
	public replay = false;
	public song: Song | null = null;

	public get player() {
		return this.client.lavalink.players.get(this.guild.id);
	}

	public get canPlay() { return Boolean(this.song || this.queue.length); }
	public get playing() { return this.player?.playing; }
	public get paused() { return this.player?.paused; }

	public get channel() {
		return (this.channelID && this.client.channels.get(this.channelID) as TextChannel) || null;
	}

	public get playingTime() {
		return this.lastUpdate ? this.position + (Date.now() - this.lastUpdate) : 0;
	}

	public get trackRemaining() {
		return this.song ? this.song.duration - this.playingTime : 0;
	}

	public get voiceChannel() {
		return this.guild.me!.voice.channel;
	}

	public get listeners(): readonly string[] {
		const { voiceChannel } = this;
		if (voiceChannel) {
			const members: string[] = [];
			for (const [id, member] of voiceChannel.members) {
				if (member.user.bot || member.voice.deaf) continue;
				members.push(id);
			}
			return members;
		}
		return [];
	}

	@enumerable(false)
	public position = 0;

	@enumerable(false)
	public lastUpdate = 0;

	public constructor(guild: Guild) {
		this.client = guild.client as SkyraClient;
		this.guild = guild;
	}

	public add(user: string, song: TrackData[], context: MusicHandlerRequestContext | null = null) {
		const parsedSongs = song.map(info => new Song(this, info, user));
		this.queue.push(...parsedSongs);
		this.client.emit(Events.MusicAdd, this, parsedSongs, context);
		return parsedSongs;
	}

	public async fetch(song: string) {
		const response = await this.getSongs(song);
		if (response.loadType === LoadType.NO_MATCHES) throw this.guild.language.tget('MUSICMANAGER_FETCH_NO_MATCHES');
		if (response.loadType === LoadType.LOAD_FAILED) throw this.guild.language.tget('MUSICMANAGER_FETCH_LOAD_FAILED');
		return response.tracks;
	}

	public setReplay(value: boolean, context: MusicHandlerRequestContext | null = null) {
		if (this.replay !== value) {
			this.replay = value;
			this.client.emit(Events.MusicReplayUpdate, this, value, context);
		}
		return this;
	}

	public async setVolume(volume: number, context: MusicHandlerRequestContext | null = null) {
		if (volume <= 0) throw this.guild.language.tget('MUSICMANAGER_SETVOLUME_SILENT');
		if (volume > 200) throw this.guild.language.tget('MUSICMANAGER_SETVOLUME_LOUD');
		await this.player!.volume(volume);
		this.client.emit(Events.MusicSongVolumeUpdate, this, this.volume, volume, context);
		this.volume = volume;
		return this;
	}

	public async seek(position: number, context: MusicHandlerRequestContext | null = null) {
		const { player } = this;
		if (player) {
			await player.seek(position);
			this.client.emit(Events.MusicSongSeekUpdate, this, position, context);
		}
		return this;
	}

	public async connect(voiceChannel: VoiceChannel, context: MusicHandlerRequestContext | null = null) {
		// Join channel and initiate the player for this guild
		await this.client.lavalink.join(
			{ guild: voiceChannel.guild.id, channel: voiceChannel.id, node: this.client.lavalink.idealNodes[0].id },
			{ selfdeaf: true }
		);

		if (this.player) {
			// Handle all the player events
			this.player
				.on(LavalinkPlayerEvents.PlayerUpdate, data => this.client.emit(Events.LavalinkPlayerUpdate, this, data))
				.on(LavalinkPlayerEvents.Start, data => this.client.emit(Events.LavalinkStart, this, data))
				.on(LavalinkPlayerEvents.Error, data => this.client.emit(Events.LavalinkException, this, data, context))
				.on(LavalinkPlayerEvents.End, data => this.client.emit(Events.LavalinkEnd, this, data));
		}

		// Emit that we connected to the websocket
		this.client.emit(Events.MusicConnect, this, voiceChannel, context);
		return this;
	}

	public async switch(voiceChannel: VoiceChannel, context: MusicHandlerRequestContext | null = null) {
		// Switch voice channels
		await this.player!.switchChannel(voiceChannel.id, { selfdeaf: true });
		this.client.emit(Events.MusicSwitch, this, voiceChannel, context);
		return this;
	}

	public async leave(context: MusicHandlerRequestContext | null = null) {
		// If a player is present
		if (this.player) {
			const { voiceChannel } = this;
			// Then leave the channel, which also destroys the entire session
			await this.client.lavalink.leave(voiceChannel!.guild.id);

			// Also reset all the local data (except queue, which is kept for follow-up sessions)
			this.reset();

			// Emit that we left to the websocket
			this.client.emit(Events.MusicLeave, this, voiceChannel, context);
		}

		return this;
	}

	public async play() {
		if (this.player) {
			// If there is no queue then tell the user they should add some songs
			if (!this.queue || !this.queue.length) return Promise.reject(this.guild.language.tget('MUSICMANAGER_PLAY_NO_SONGS'));
			// If we're already playing then tell the user that they can listen right now
			if (this.playing && !this.paused) return Promise.reject(this.guild.language.tget('MUSICMANAGER_PLAY_PLAYING'));

			// Set the song to the first entry of the queue
			this.song = this.queue.shift()!;
			// And play it
			await this.player.play(this.song.track);
		}

		return this;
	}

	public async pause(systemPaused = false, context: MusicHandlerRequestContext | null = null) {
		if (this.playing && !this.paused) {
			await this.player!.pause(true);
			this.systemPaused = systemPaused;
			this.client.emit(Events.MusicSongPause, this, context);
		}
		return this;
	}

	public async resume(context: MusicHandlerRequestContext | null = null) {
		if (this.playing && this.paused) {
			await this.player!.pause(false);
			await this.player!.resume();
			this.client.emit(Events.MusicSongResume, this, context);
		}
		return this;
	}

	public async skip(context: MusicHandlerRequestContext | null = null) {
		if (this.song !== null) {
			// Stop playing current track, this will trigger TrackEndEven on Lavalink
			await this.player!.stop();

			// Emit to the websocket that we skipped a song
			this.client.emit(Events.MusicSongSkip, this, this.song, context);
		}
		return this;
	}

	public prune(context: MusicHandlerRequestContext | null = null) {
		this.client.emit(Events.MusicPrune, this, context);
		return this;
	}

	public shuffle(context: MusicHandlerRequestContext | null = null) {
		let m = this.queue.length;
		while (m) {
			const i = Math.floor(Math.random() * m--);
			[this.queue[m], this.queue[i]] = [this.queue[i], this.queue[m]];
		}
		this.client.emit(Events.MusicShuffleQueue, this, context);
		return this.queue;
	}

	public promote(index: number, context: MusicHandlerRequestContext | null = null) {
		if (context) {
			// Decrease index by 1 because end-users do not think in zero-based arrays
			index--;

			// Get the song to promote and remove it from the queue
			const songToPromote = this.queue.splice(index, 1)[0];

			// Move the song to the front of the queue
			this.queue.unshift(songToPromote);

			// Emit the queue change event to the websocket
			this.client.emit(Events.MusicPromoteQueue, this, context);

			// Return the new queue
			return this.queue;
		}
	}

	public remove(message: KlasaMessage, index: number, context: MusicHandlerRequestContext | null = null) {
		// Decrease index by 1 because end-users do not think in zero-based arrays
		index--;

		// Get the song that will be removed
		const song = this.queue[index];

		// If song was requested by someone else and the user is not an admin/DJ then restrict the use of the command
		if (song.requester !== message.author.id && !message.member!.isDJ) {
			throw message.language.tget('COMMAND_REMOVE_DENIED');
		}

		// Splice the song out in-place
		this.queue.splice(index, 1);

		// Tell the websocket of the removed song
		this.client.emit(Events.MusicRemove, this, song, context);

	}

	public reset(volume = false) {
		this.song = null;
		this.position = 0;
		this.lastUpdate = 0;
		this.systemPaused = false;
		this.replay = false;
		if (volume) this.volume = this.guild.settings.get(GuildSettings.Music.DefaultVolume);
	}

	public async manageableFor(message: KlasaMessage) {
		const { listeners } = this;

		// If the member is the only listener, they receive full permissions on them.
		if (listeners.length === 0 && listeners[0] === message.author.id) return true;
		// If the member is a DJ, queues are always manageable for them.
		if (message.member!.isDJ) return true;
		// If the current song and all queued songs are requested by the author, the queue is still manageable.
		if ((this.song ? this.song.requester === message.author.id : true) && this.queue.every(song => song.requester === message.author.id)) return true;
		// Else if the author is a moderator+, queues are always manageable for them.
		return message.hasAtLeastPermissionLevel(5);
	}

	public *websocketUserIterator() {
		for (const user of this.client.websocket.users.values()) {
			if (user.musicSubscriptions.subscribed(this.guild.id)) yield user;
		}
	}

	public toJSON() {
		return flattenMusicHandler(this);
	}

	private getSongs(search: string) {
		const node = this.client.lavalink.idealNodes[0];

		const llUrl = new URL(`http://${node.host}:${node.port}/loadtracks`);
		llUrl.searchParams.append('identifier', search);

		return fetch<TrackResponse>(llUrl, {
			headers: {
				authorization: node.password
			}
		}, FetchResultTypes.JSON);
	}

}

export interface MusicHandlerRequestContext {
	channel?: TextChannel;
	userID: string;
}
