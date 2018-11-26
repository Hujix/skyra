import { Message, MessageCollector, MessageEmbed } from 'discord.js';
import { Schema, SchemaFolder, SchemaPiece, SettingsFolderUpdateOptions } from 'klasa';
import { WSMessageReactionAdd } from '../types/Discord';
import { LongLivingReactionCollector } from '../util/LongLivingReactionCollector';

const EMOJIS = { BACK: '◀', STOP: '⏹' };

export class SettingsMenu {

	private message: Message;
	private schema: Schema | SchemaPiece = this.message.client.gateways.get('guilds').schema;
	private oldSettings = this.message.guild.settings.clone();
	private messageCollector: MessageCollector;
	private errorMessage;
	private llrc: LongLivingReactionCollector;
	private embed = new MessageEmbed()
		.setAuthor(this.message.author.username, this.message.author.displayAvatarURL({ size: 128 }))
		.setColor(this.message.member.displayColor);
	private response: Message = null;

	public constructor(message: Message) {
		this.message = message;
	}

	private get pointerIsFolder(): boolean {
		return this.schema instanceof Schema;
	}

	private get changedCurrentPieceValue(): boolean {
		if (this.schema.type === 'Folder') return false;
		const schema = this.schema as SchemaPiece;
		if (schema.array) {
			const current = this.message.guild.settings.get(this.schema.path) as any[];
			const old = this.oldSettings.get(this.schema.path) as any[];
			return current.length !== old.length || current.some((value, i) => value !== old[i]);
		}
		// tslint:disable-next-line:triple-equals
		return this.message.guild.settings.get(this.schema.path) != this.oldSettings.get(this.schema.path);
	}

	private get changedPieceValue(): boolean {
		if (this.schema.type === 'Folder') return false;
		const schema = this.schema as SchemaPiece;
		// tslint:disable-next-line:triple-equals
		return this.message.guild.settings.get(this.schema.path) != schema.default;
	}

	public async init(): Promise<void> {
		// @ts-ignore
		this.response = await this.message.send(this.message.language.get('SYSTEM_LOADING'));
		await this.response.react(EMOJIS.STOP);
		this.llrc = new LongLivingReactionCollector(this.message.client)
			.setListener(this.onReaction.bind(this))
			.setEndListener(this.stop.bind(this));
		this.llrc.setTime(120000);
		this.messageCollector = this.response.channel.createMessageCollector((msg) => msg.author.id === this.message.author.id);
		this.messageCollector.on('collect', (msg) => this.onMessage(msg));
		await this.response.edit(this.render());
	}

	private render(): MessageEmbed {
		const i18n = this.message.language;
		const description = [];
		if (this.pointerIsFolder) {
			description.push(i18n.get('COMMAND_CONF_MENU_RENDER_AT_FOLDER', this.schema.path || 'Root'));
			if (this.errorMessage) description.push(this.errorMessage);
			const keys = [], folders = [];
			for (const [key, value] of (this.schema as Schema).entries()) {
				if (value.type === 'Folder') {
					if ((value as Schema).configurableKeys.length) folders.push(key);
				} else if ((value as SchemaPiece).configurable) {
					keys.push(key);
				}
			}

			if (!folders.length && !keys.length) description.push(i18n.get('COMMAND_CONF_MENU_RENDER_NOKEYS'));
			else description.push(i18n.get('COMMAND_CONF_MENU_RENDER_SELECT'), '', ...folders.map((folder) => `• \\📁${folder}`), ...keys.map((key) => `• ${key}`));
		} else {
			description.push(i18n.get('COMMAND_CONF_MENU_RENDER_AT_PIECE', this.schema.path));
			if (this.errorMessage) description.push('\n', this.errorMessage, '\n');
			if ((this.schema as SchemaPiece).configurable) {
				description.push(
					i18n.get(`SETTINGS_${this.schema.path.replace(/[.-]/g, '_').toUpperCase()}`),
					'',
					i18n.get('COMMAND_CONF_MENU_RENDER_TCTITLE'),
					i18n.get('COMMAND_CONF_MENU_RENDER_UPDATE'),
					(this.schema as SchemaPiece).array && (this.message.guild.settings.get(this.schema.path) as any[]).length ? i18n.get('COMMAND_CONF_MENU_RENDER_REMOVE') : null,
					this.changedPieceValue ? i18n.get('COMMAND_CONF_MENU_RENDER_RESET') : null,
					this.changedCurrentPieceValue ? i18n.get('COMMAND_CONF_MENU_RENDER_UNDO') : null,
					'',
					i18n.get('COMMAND_CONF_MENU_RENDER_CVALUE', this.message.guild.settings.display(this.message, this.schema).replace(/``+/g, '`\u200B`')));
			}
		}

		const parent = (this.schema as SchemaPiece | SchemaFolder).parent;

		if (parent) this.response.react(EMOJIS.BACK);
		else this._removeReactionFromUser(EMOJIS.BACK, this.message.client.user);

		return this.embed
			.setDescription(`${description.filter((v) => v !== null).join('\n')}\n\u200B`)
			.setFooter(parent ? i18n.get('COMMAND_CONF_MENU_RENDER_BACK') : '')
			.setTimestamp();
	}

	private async onMessage(message: Message): Promise<void> {
		this.errorMessage = null;
		if (this.pointerIsFolder) {
			const schema = (this.schema as Schema).get(message.content);
			if (schema && (schema.type === 'Folder' ? (schema as Schema).configurableKeys.length : (schema as SchemaPiece).configurable)) this.schema = schema;
			else this.errorMessage = this.message.language.get('COMMAND_CONF_MENU_INVALID_KEY');
		} else {
			const [command, ...params] = message.content.split(' ');
			const commandLowerCase = command.toLowerCase();
			if (commandLowerCase === 'set') await this.tryUpdate(params.join(' '), { arrayAction: 'add' });
			else if (commandLowerCase === 'remove') await this.tryUpdate(params.join(' '), { arrayAction: 'remove' });
			else if (commandLowerCase === 'reset') await this.tryUpdate(null);
			else if (commandLowerCase === 'undo') await this.tryUndo();
			else this.errorMessage = this.message.language.get('COMMAND_CONF_MENU_INVALID_ACTION');
		}

		if (!this.errorMessage) message.nuke();
		await this.message.send(this.render());
	}

	private async onReaction(reaction: WSMessageReactionAdd, user: { id: string }): Promise<void> {
		if (user.id !== this.message.author.id) return;
		this.llrc.setTime(120000);
		if (reaction.emoji.name === EMOJIS.STOP) {
			this.llrc.end();
		} else if (reaction.emoji.name === EMOJIS.BACK) {
			this._removeReactionFromUser(EMOJIS.BACK, user);
			this.schema = (this.schema as SchemaFolder | SchemaPiece).parent;
			await this.response.edit(this.render());
		}
	}

	private _removeReactionFromUser(reaction: string, user: { id: string }): Promise<any> {
		// @ts-ignore
		return this.message.client.api.channels[this.message.channel.id].messages[this.response.id]
			.reactions(encodeURIComponent(reaction), user.id === this.message.client.user.id ? '@me' : user.id)
			.delete();
	}

	private async tryUpdate(value: any, options?: SettingsFolderUpdateOptions): Promise<void> {
		const { errors, updated } = await (value === null
			? this.message.guild.settings.reset(this.schema.path)
			: this.message.guild.settings.update(this.schema.path, value, options));
		if (errors.length) this.errorMessage = String(errors[0]);
		else if (!updated.length) this.errorMessage = this.message.language.get('COMMAND_CONF_NOCHANGE', (this.schema as SchemaPiece).key);
	}

	private async tryUndo(): Promise<void> {
		if (!this.changedCurrentPieceValue) {
			this.errorMessage = this.message.language.get('COMMAND_CONF_NOCHANGE', (this.schema as SchemaPiece).key);
		} else {
			const previousValue = this.oldSettings.get(this.schema.path);
			const { errors } = await (previousValue === null
				? this.message.guild.settings.reset(this.schema.path)
				: this.message.guild.settings.update(this.schema.path, previousValue, { arrayAction: 'overwrite' }));
			if (errors.length) this.errorMessage = String(errors[0]);
		}
	}

	private stop(): void {
		if (this.response.reactions.size) this.response.reactions.removeAll();
		if (!this.messageCollector.ended) this.messageCollector.stop();
		this.response.edit(this.message.language.get('COMMAND_CONF_MENU_SAVED'), { embed: null })
			.catch((error) => this.message.client.emit('apiError', error));
	}

}