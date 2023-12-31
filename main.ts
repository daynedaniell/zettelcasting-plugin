import { App, Editor, MarkdownView, Modal, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
const Obsidian = require('obsidian');
// Remember to rename these classes and interfaces!

interface MyPluginSettings {
	my_setting: string;
	zettelcasting_api_key: string;
}

const DEFAULT_SETTINGS: MyPluginSettings = {
	my_setting: 'default',
	zettelcasting_api_key: '1234567891011',
	
	
}


export default class ZettelCastingPlugin extends Plugin {
	settings: MyPluginSettings;

	async onload() {
		//await this.loadSettings();
		this.app.workspace.onLayoutReady(this.initialize.bind(this));

		// This creates an icon in the left ribbon.
		const ribbonIconEl = this.addRibbonIcon('dice', 'ZettelCasting', (evt: MouseEvent) => {
			// Called when the user clicks the icon.
			new Notice('This is a notice!');
		});
		// Perform additional things with the ribbon
		ribbonIconEl.addClass('my-plugin-ribbon-class');

		// This adds a status bar item to the bottom of the app. Does not work on mobile apps.
		const statusBarItemEl = this.addStatusBarItem();
		statusBarItemEl.setText('Status Bar Text');

		// This adds a simple command that can be triggered anywhere
		this.addCommand({
			id: 'open-sample-modal-simple',
			name: 'Open sample modal (simple)',
			callback: () => {
				new SampleModal(this.app).open();
			}
		});


		// This adds an editor command that can perform some operation on the current editor instance
		this.addCommand({
			id: 'sample-editor-command',
			name: 'Sample editor command',
			editorCallback: async (editor: { somethingSelected: () => any; getSelection: () => any; }) => {
					const activeFile = this.app.workspace.getActiveFile();
	
// Read the currently open note file. We are reading it off the HDD - we are NOT accessing the editor to do this.
						let text = await this.app.vault.read
						if(activeFile) {
						let file_content = await this.app.vault.cachedRead(activeFile);
						let selected_text = file_content;
						console.log('this is the selected text', selected_text);
						 this.send_note(selected_text,  this.settings.zettelcasting_api_key);
						}
						
			}
		});
		// This adds a complex command that can check whether the current state of the app allows execution of the command
		this.addCommand({
			id: 'open-sample-modal-complex',
			name: 'Open sample modal (complex)',
			checkCallback: (checking: boolean) => {
				// Conditions to check
				const markdownView = this.app.workspace.getActiveViewOfType(MarkdownView);
				if (markdownView) {
					// If checking is true, we're simply "checking" if the command can be run.
					// If checking is false, then we want to actually perform the operation.
					// This command will only show up in Command Palette when the check function returns true
					return true;
				}
			}
		});

		// This adds a settings tab so the user can configure various aspects of the plugin
		this.addSettingTab(new SampleSettingTab(this.app, this));

		// If the plugin hooks up any global DOM events (on parts of the app that doesn't belong to this plugin)
		// Using this function will automatically remove the event listener when this plugin is disabled.
		this.registerDomEvent(document, 'click', (evt: MouseEvent) => {
			console.log('click', evt);
		});

		// When registering intervals, this function will automatically clear the interval when the plugin is disabled.
		this.registerInterval(window.setInterval(() => console.log('setInterval'), 5 * 60 * 1000));
	}

	onunload() {

	}

	async initialize() {
		await this.loadSettings();
	}	

	async loadSettings() {
		this.settings = Object.assign({}, DEFAULT_SETTINGS);
		this.addCommand({
		id: 'zc-send-note',
		name: "Find: ZettelCasting - Send Note",
		icon: "pencil_icon",
		editorCallback: async(editor: { somethingSelected: () => any; getSelection: () => any; }) => {
			if(editor.somethingSelected()) {
				let selected_text = editor.getSelection();
				let note_link = await this.send_note(selected_text, this.settings.zettelcasting_api_key);
			}
		}	
		})
	}

async send_note(text: string, zettelcasting_api_key: string) {
		const response =  await fetch("http://localhost:3000/api/v1/processnotes", {
			method: "POST",
			mode: "cors",
			headers: {
				"Content-Type": "application/json",
				"Authorization": `Bearer ${zettelcasting_api_key}`
			},
			body: JSON.stringify({
				text: text,
				"zettelcasting_api_key": zettelcasting_api_key
				
			})
		});
		console.log('here is the response', response);
	}

		async saveSettings() {
		await this.saveData(this.settings);
	}

	}

	class SampleModal extends Modal {
	constructor(app: App) {
		super(app);
	}

	onOpen() {
		const {contentEl} = this;
		contentEl.setText('Woah!');
	}

	onClose() {
		const {contentEl} = this;
		contentEl.empty();
	}
}

class SampleSettingTab extends PluginSettingTab {
	plugin: ZettelCastingPlugin;

	constructor(app: App, plugin: ZettelCastingPlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const {containerEl} = this;

		containerEl.empty();

		new Setting(containerEl)
			.setName('ZettelCasting API Key')
			.setDesc('It\'s a secret')
			.addText(text => text
				.setPlaceholder('Enter your secret')
				.setValue(this.plugin.settings.zettelcasting_api_key)
				.onChange(async (value) => {
					this.plugin.settings.zettelcasting_api_key = value;
					await this.plugin.saveSettings();
				}));		
	}
}