import { DbSet } from '@lib/structures/DbSet';
import { SkyraCommand } from '@lib/structures/SkyraCommand';
import { CommandStore, KlasaMessage } from 'klasa';

export default class extends SkyraCommand {

	public constructor(store: CommandStore, file: string[], directory: string) {
		super(store, file, directory, {
			aliases: ['darkmode', 'toggledarktheme', 'darktheme'],
			cooldown: 5,
			description: language => language.tget('COMMAND_TOGGLEDARKMODE_DESCRIPTION'),
			extendedHelp: language => language.tget('COMMAND_TOGGLEDARKMODE_EXTENDED')
		});
	}

	public async run(message: KlasaMessage, []: []) {
		const { users } = await DbSet.connect();
		const updated = await users.lock([message.author.id], async id => {
			const user = await users.ensureProfile(id);

			user.profile.darkTheme = !user.profile.darkTheme;
			return user.save();
		});

		return message.sendLocale('COMMAND_TOGGLEDARKMODE_TOGGLED', [updated.profile.darkTheme]);
	}

}
