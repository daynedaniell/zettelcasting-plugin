
/**
 * Stand-in for the `obsidian` module, which only exists inside the app.
 *
 * The UI classes are inert shells — enough for the modules under test to load.
 * `parseLinktext` and `resolveSubpath` are real implementations, because the
 * baking logic depends on their exact semantics.
 */

export interface StubRequestUrlParam {
  url: string;
  method?: string;
  contentType?: string;
  body?: string | ArrayBuffer;
  headers?: Record<string, string>;
  throw?: boolean;
}

/**
 * Swappable implementation behind the `requestUrl` export. Tests assign
 * `requestUrlStub.impl` to feed canned responses; the indirection exists
 * because an imported binding can't be reassigned from outside the module.
 */
export const requestUrlStub = {
  impl: (param: StubRequestUrlParam): unknown => {
    throw new Error(`Unstubbed requestUrl call to ${param.url}`);
  },
};

export function requestUrl(param: StubRequestUrlParam): Promise<unknown> {
  return Promise.resolve(requestUrlStub.impl(param));
}

export class Modal {
  app: any;
  contentEl: any = null;
  titleEl: any = null;
  modalEl: any = null;
  constructor(app: any) {
    this.app = app;
  }
  open() {}
  close() {}
}

export class Setting {
  setName() {
    return this;
  }
  setDesc() {
    return this;
  }
  addToggle() {
    return this;
  }
  addText() {
    return this;
  }
  addButton() {
    return this;
  }
  addDropdown() {
    return this;
  }
  setHeading() {
    return this;
  }
  then(cb: (setting: Setting) => void) {
    cb(this);
    return this;
  }
}

export class Notice {
  constructor(public message?: string) {}
}

export class Component {
  onload() {}
  onunload() {}
  registerDomEvent() {}
  registerInterval(id: number) {
    return id;
  }
  register() {}
  addChild(child: any) {
    return child;
  }
}

/**
 * Inert, like the other UI shells here. The block host's behaviour is driven by
 * a real DOM inside Obsidian; what the tests cover is the cache, the client and
 * the config parser it delegates to.
 */
export class MarkdownRenderChild extends Component {
  constructor(public containerEl: any) {
    super();
  }
}

export function setIcon(_parent: any, _iconId: string) {}

export class Plugin {
  constructor(public app: any, public manifest: any) {}
  addCommand() {}
  addSettingTab() {}
  registerMarkdownCodeBlockProcessor() {}
  async loadData() {
    return {};
  }
  async saveData() {}
}

export class PluginSettingTab {
  containerEl: any = null;
  constructor(public app: any, public plugin: any) {}
  display() {}
  hide() {}
}

export class TFile {
  path = '';
  basename = '';
  extension = '';
  name = '';
  parent: { path: string } | null = null;
}

export class TFolder {
  path = '';
}

export const Platform = { isWin: false, isMobile: false };

/**
 * Obsidian bundles js-yaml; there is no point reimplementing it here. Every
 * caller under test takes its parser as a parameter precisely so the tests can
 * supply one, so reaching this is a sign an injection was forgotten.
 */
export function parseYaml(_input: string): unknown {
  throw new Error('parseYaml is not stubbed — inject a parser in the test');
}

/** Split `note#heading` into its path and subpath halves, as Obsidian does. */
export function parseLinktext(link: string): { path: string; subpath: string } {
  const hash = link.indexOf('#');
  return hash === -1
    ? { path: link, subpath: '' }
    : { path: link.slice(0, hash), subpath: link.slice(hash) };
}

/**
 * Resolve `#Heading` to its section and `#^id` to its block, matching Obsidian:
 * a heading section runs until the next heading of the same or higher level.
 */
export function resolveSubpath(cache: any, subpath: string): any {
  if (!subpath) return null;
  const target = subpath.replace(/^#/, '');
  if (!target) return null;

  if (target.startsWith('^')) {
    const block = cache.blocks?.[target.slice(1)];
    if (!block) return null;
    const list = (cache.listItems ?? []).find(
      (item: any) =>
        item.position.start.offset === block.position.start.offset
    );
    return {
      type: 'block',
      block,
      list,
      start: block.position.start,
      end: block.position.end,
    };
  }

  const headings: any[] = cache.headings ?? [];
  const index = headings.findIndex(
    (h) => h.heading.toLowerCase() === target.toLowerCase()
  );
  if (index === -1) return null;

  const current = headings[index];
  const next = headings
    .slice(index + 1)
    .find((h) => h.level <= current.level);

  return {
    type: 'heading',
    current,
    start: current.position.start,
    end: next ? next.position.start : null,
  };
}
