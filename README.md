# ZettelCasting

Turn the notes you already write into scheduled social posts, without leaving Obsidian.

ZettelCasting assembles a note — following its links and embeds so the finished post is
self-contained — and schedules it to the social platforms you have connected to your
[ZettelCasting](https://zettelcasting.com) account. A copy of exactly what was sent is saved
back into your vault next to the source note.

## What it does

- **Assembles the post from your note.** Links and embeds that sit on their own line are
  replaced inline with the content of the note they point to, recursively. A note that reads as
  a hub of `[[atomic notes]]` goes out as one continuous post rather than as a list of dead
  wikilinks.
- **Uploads embedded media.** Embedded images and videos (`png`, `jpg`, `jpeg`, `gif`, `webp`,
  `mp4`, `mov`, `webm`) are uploaded and attached to the post, and removed from the post body.
  If an upload fails, nothing is scheduled — you never get a post missing its image.
- **Reflows for social, optionally.** *Smart formatting* folds the hard line breaks that make
  sense in a vault but read badly in a feed, turning wrapped lines and stacked short paragraphs
  into running prose. Headings, lists, quotes and code blocks keep their own lines.
- **Schedules rather than fires.** Pick a date and time; the post is queued with ZettelCasting
  for that moment. Leaving the picker alone schedules it for now.
- **Leaves a record.** After scheduling, the post is written to `<note name>.zcast.md` beside
  the source note and opened in a new tab. It matches what went out, except that it keeps
  `file://` links to local attachments — those resolve in your vault, so they belong in the
  copy that stays there and never in the one that leaves.

## Requirements

- A [ZettelCasting](https://zettelcasting.com) account with at least one social platform
  connected in your dashboard.
- Obsidian 1.4.0 or later, on desktop. The plugin is desktop-only because converting links to
  non-Markdown files needs filesystem paths.

## Installation

### From the community plugins list

Settings → Community plugins → Browse → search for **ZettelCasting** → Install → Enable.

### Manually

1. Download `main.js`, `manifest.json` and `styles.css` from the
   [latest release](https://github.com/daynedaniell/zettelcasting-plugin/releases).
2. Put them in `<your vault>/.obsidian/plugins/zettelcasting/`.
3. Reload Obsidian and enable the plugin under Settings → Community plugins.

## Setup

1. Open Settings → Community plugins → **ZettelCasting**.
2. Paste your **ZettelCasting API key**. You will find it in your dashboard at
   [zettelcasting.com](https://zettelcasting.com).
3. The **Default platform** dropdown fills itself with the platforms your account has actually
   connected. If it stays empty, connect a platform in the dashboard and reopen the settings tab.

The key is stored in this plugin's settings file in your vault and is sent only to
`zettelcasting.com`.

## Usage

Open the command palette and run **Send to ZettelCasting - current file** to publish the
active note.

That opens the **Schedule post** dialog, where you can:

- Toggle the assembly options for this post (the toggles double as your saved defaults).
- Press **Calculate word count** to see the length of the text that will actually be sent,
  after assembly and formatting.
- Pick the date and time to publish.
- Choose which connected platform to publish to.
- Edit the filename of the local copy that gets written.

Press **Schedule Post** to send it.

### Branch Writing

The ZettelCasting plugin fully supports Santi Younger's
[Branch Writing](https://platform.santiyounger.com/branch-writing) plugin for Obsidian. When a
Branch Writing view is focused with a card selected, two more commands become available:

| Command | Publishes |
| ------- | --------- |
| **Send to ZettelCasting - active card** | The selected card on its own |
| **Send to ZettelCasting - active branch** | The selected card and everything beneath it |

Both stay hidden otherwise, so they never clutter the command palette. They open the same
**Schedule post** dialog as the whole-note command.

The author of this plugin is not affiliated with Santi Younger or with the Branch Writing
plugin.

## Settings

Everything under *Baking defaults* is the starting state of the dialog; changing a toggle in
either place updates the other.

| Setting | What it does |
| ------- | ------------ |
| **Convert embedded markdown** | Inline the content of `![[embedded markdown files]]` that sit on their own line. |
| **Convert links** | Inline the content of `[[any link]]` that sits on its own line. |
| **Convert links and embeds in lists** | Do the same when the link takes up an entire list bullet, preserving indentation. |
| **Convert file links** | Rewrite links to non-Markdown files as `![](file:///full/path/…)` **in the local copy only**. These links never go out with the post. Off by default. |
| **Smart formatting** | Reflow the post into flowing paragraphs. Off by default, since it rewrites the body. |

Inline links — links with text around them on the same line — are always left as plain text
rather than inlined, and a note never inlines itself or an ancestor, so cycles are safe.

Frontmatter and comments are stripped from everything before it goes out. Both `%%Obsidian
comments%%` and `<!-- HTML comments -->` are private annotations that render as nothing in your
vault, so they are removed rather than published — except inside code blocks and code spans,
which are published exactly as written.

## Network use

The plugin talks to `https://zettelcasting.com` and nowhere else. It makes three kinds of
request, all authenticated with your API key:

- `GET /api/integrations/pkm/platforms` — to list the platforms your account has connected.
  Sent when the settings tab or the publish dialog opens.
- `POST /api/integrations/pkm/media` — uploads an embedded image or video, when the note you
  are publishing contains one.
- `POST /api/integrations/pkm/posts` — schedules the post. Sends the assembled post body, the
  target platform, the scheduled time and the URLs of any uploaded media.

Nothing is sent until you run one of the commands, apart from the platform lookup that
populates the dropdown.

## Development

```bash
npm install
npm run dev      # watch build into main.js
npm run build    # type-check and produce a production main.js
npm test         # run the test suite
npm run check    # type-check, lint and test
```

The plugin entry point is [`src/main.ts`](src/main.ts). Note assembly lives in
[`src/BakeModal.ts`](src/BakeModal.ts) and [`src/util.ts`](src/util.ts); the Branch Writing
integration is isolated in [`src/branch-writing.ts`](src/branch-writing.ts).

## Credits

The note assembly logic (`bake()` and most of `src/util.ts`) is derived from
[Easy Bake](https://github.com/mgmeyers/obsidian-easy-bake) by Matthew Meyers, used and
redistributed under the GPL-3.0.

## License

[GPL-3.0-or-later](LICENSE).

    Copyright (C) Matthew Meyers — original Easy Bake source
    Copyright (C) 2026 Dayne Daniell — ZettelCasting modifications

This program is free software: you can redistribute it and/or modify it under the terms of the
GNU General Public License as published by the Free Software Foundation, either version 3 of
the License, or (at your option) any later version. It is distributed in the hope that it will
be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or
FITNESS FOR A PARTICULAR PURPOSE. See the [LICENSE](LICENSE) file for details.
