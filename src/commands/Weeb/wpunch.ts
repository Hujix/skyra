import { WeebCommand } from '@lib/structures/WeebCommand';
import { CommandStore } from 'klasa';

export default class extends WeebCommand {

	public constructor(store: CommandStore, file: string[], directory: string) {
		super(store, file, directory, {
			description: language => language.tget('COMMAND_WPUNCH_DESCRIPTION'),
			extendedHelp: language => language.tget('COMMAND_WPUNCH_EXTENDED'),
			queryType: 'punch',
			responseName: 'COMMAND_WPUNCH',
			usage: '<user:username>'
		});
	}

}
