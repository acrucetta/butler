const CODE_BLOCK_PATTERN = /```([^\n`]*)\n?([\s\S]*?)```/g;
const INLINE_CODE_PATTERN = /`([^`\n]+?)`/g;
const LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const BOLD_ITALIC_PATTERN = /\*\*\*([^*\n][^*\n]*?)\*\*\*/g;
const BOLD_PATTERN = /\*\*([^*\n][^*\n]*?)\*\*/g;
const ITALIC_STAR_PATTERN = /(^|[\s(])\*([^*\n][^*\n]*?)\*(?=$|[\s).,!?:;])/g;
const ITALIC_UNDERSCORE_PATTERN = /(^|[\s(])_([^_\n][^_\n]*?)_(?=$|[\s).,!?:;])/g;
const UNDERLINE_PATTERN = /__([^_\n][^_\n]*?)__/g;
const STRIKETHROUGH_DOUBLE_PATTERN = /~~([^~\n][^~\n]*?)~~/g;
const STRIKETHROUGH_SINGLE_PATTERN = /(^|[\s(])~([^~\n][^~\n]*?)~(?=$|[\s).,!?:;])/g;
const HEADING_PATTERN = /^\s*#{1,6}\s+(.+)$/;
const BULLET_PATTERN = /^\s*[-*]\s+(.+)$/;
const ORDERED_LIST_PATTERN = /^\s*(\d+)\.\s+(.+)$/;
const BLOCKQUOTE_PATTERN = /^\s*>\s?(.*)$/;
const HORIZONTAL_RULE_PATTERN = /^\s{0,3}([-*_])(?:\s*\1){2,}\s*$/;
const MARKDOWN_V2_ESCAPE_PATTERN = /[_*[\]()~`>#+\-=|{}.!]/g;

export function toTelegramMarkdownV2(markdown: string): string {
  const replacements: string[] = [];
  let working = markdown.replace(/\r\n?/g, "\n");

  working = replaceMarkdownTables(working, replacements);

  working = working.replace(CODE_BLOCK_PATTERN, (_match, language: string, code: string) =>
    createToken(replacements, renderCodeBlock(language, code))
  );

  working = working.replace(INLINE_CODE_PATTERN, (_match, code: string) =>
    createToken(replacements, renderInlineCode(code))
  );

  working = working.replace(LINK_PATTERN, (_match, label: string, url: string) =>
    createToken(replacements, renderLink(label, url))
  );

  working = working.replace(BOLD_ITALIC_PATTERN, (_match, content: string) =>
    createToken(replacements, renderBoldItalic(content))
  );

  working = working.replace(BOLD_PATTERN, (_match, content: string) =>
    createToken(replacements, renderBold(content))
  );

  working = working.replace(ITALIC_STAR_PATTERN, (_match, prefix: string, content: string) =>
    `${prefix}${createToken(replacements, renderItalic(content))}`
  );

  working = working.replace(ITALIC_UNDERSCORE_PATTERN, (_match, prefix: string, content: string) =>
    `${prefix}${createToken(replacements, renderItalic(content))}`
  );

  working = working.replace(UNDERLINE_PATTERN, (_match, content: string) =>
    createToken(replacements, renderUnderline(content))
  );

  working = working.replace(STRIKETHROUGH_DOUBLE_PATTERN, (_match, content: string) =>
    createToken(replacements, renderStrikethrough(content))
  );

  working = working.replace(STRIKETHROUGH_SINGLE_PATTERN, (_match, prefix: string, content: string) =>
    `${prefix}${createToken(replacements, renderStrikethrough(content))}`
  );

  const escaped = working
    .split("\n")
    .map((line) => renderLine(line))
    .join("\n");

  return restoreTokens(escaped, replacements);
}

function renderLine(line: string): string {
  const headingMatch = line.match(HEADING_PATTERN);
  if (headingMatch) {
    return `*${escapeMarkdownV2Text(headingMatch[1] ?? "")}*`;
  }

  const bulletMatch = line.match(BULLET_PATTERN);
  if (bulletMatch) {
    return `\\- ${escapeMarkdownV2Text(bulletMatch[1] ?? "")}`;
  }

  const orderedMatch = line.match(ORDERED_LIST_PATTERN);
  if (orderedMatch) {
    return `${orderedMatch[1]}\\. ${escapeMarkdownV2Text(orderedMatch[2] ?? "")}`;
  }

  const blockquoteMatch = line.match(BLOCKQUOTE_PATTERN);
  if (blockquoteMatch) {
    return `> ${escapeMarkdownV2Text(blockquoteMatch[1] ?? "")}`;
  }

  if (HORIZONTAL_RULE_PATTERN.test(line)) {
    return escapeMarkdownV2Text("----------");
  }

  return escapeMarkdownV2Text(line);
}

function escapeMarkdownV2Text(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(MARKDOWN_V2_ESCAPE_PATTERN, "\\$&");
}

function escapeMarkdownV2Url(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/[()]/g, "\\$&");
}

function escapeCodeContent(value: string): string {
  return value
    .replace(/\\/g, "\\\\")
    .replace(/`/g, "\\`");
}

function renderCodeBlock(language: string, code: string): string {
  const safeLanguage = language.trim().replace(/[^a-zA-Z0-9_+-]/g, "");
  const body = escapeCodeContent(code.replace(/\r\n?/g, "\n"));
  const normalizedBody = body.endsWith("\n") ? body : `${body}\n`;

  if (safeLanguage.length > 0) {
    return "```" + safeLanguage + "\n" + normalizedBody + "```";
  }

  return "```\n" + normalizedBody + "```";
}

function renderInlineCode(code: string): string {
  return "`" + escapeCodeContent(code) + "`";
}

function renderLink(label: string, url: string): string {
  return `[${escapeMarkdownV2Text(label)}](${escapeMarkdownV2Url(url)})`;
}

function renderBold(content: string): string {
  return `*${escapeMarkdownV2Text(content)}*`;
}

function renderItalic(content: string): string {
  return `_${escapeMarkdownV2Text(content)}_`;
}

function renderUnderline(content: string): string {
  return `__${escapeMarkdownV2Text(content)}__`;
}

function renderBoldItalic(content: string): string {
  return `*_${escapeMarkdownV2Text(content)}_*`;
}

function renderStrikethrough(content: string): string {
  return `~${escapeMarkdownV2Text(content)}~`;
}

function replaceMarkdownTables(value: string, replacements: string[]): string {
  const lines = value.split("\n");
  const output: string[] = [];
  let index = 0;

  while (index < lines.length) {
    if (isTableHeader(lines[index]) && isTableSeparator(lines[index + 1])) {
      const tableLines: string[] = [lines[index], lines[index + 1]];
      index += 2;
      while (index < lines.length && isTableRow(lines[index])) {
        tableLines.push(lines[index]);
        index += 1;
      }
      output.push(createToken(replacements, renderTableAsCodeBlock(tableLines)));
      continue;
    }

    output.push(lines[index] ?? "");
    index += 1;
  }

  return output.join("\n");
}

function isTableHeader(line: string | undefined): boolean {
  if (!line) {
    return false;
  }
  return /^\s*\|?[^|\n]+(\|[^|\n]+)+\|?\s*$/.test(line);
}

function isTableSeparator(line: string | undefined): boolean {
  if (!line) {
    return false;
  }
  return /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/.test(line);
}

function isTableRow(line: string | undefined): boolean {
  if (!line) {
    return false;
  }
  return /^\s*\|?[^|\n]+(\|[^|\n]+)+\|?\s*$/.test(line);
}

function renderTableAsCodeBlock(tableLines: string[]): string {
  const rows = tableLines
    .filter((_line, rowIndex) => rowIndex !== 1)
    .map((line) => splitTableCells(line));
  const columnCount = Math.max(...rows.map((row) => row.length));
  const widths = new Array<number>(columnCount).fill(0);

  for (const row of rows) {
    for (let column = 0; column < columnCount; column += 1) {
      const cell = row[column] ?? "";
      widths[column] = Math.max(widths[column] ?? 0, cell.length);
    }
  }

  const renderedRows = rows.map((row, rowIndex) => {
    const cells = new Array<string>(columnCount).fill("");
    for (let column = 0; column < columnCount; column += 1) {
      const cell = row[column] ?? "";
      cells[column] = cell.padEnd(widths[column] ?? cell.length, " ");
    }

    const rendered = `| ${cells.join(" | ")} |`;
    if (rowIndex === 0) {
      const divider = `|-${widths.map((width) => "-".repeat(Math.max(width, 1))).join("-|-")}-|`;
      return `${rendered}\n${divider}`;
    }
    return rendered;
  });

  return renderCodeBlock("", renderedRows.join("\n"));
}

function splitTableCells(line: string): string[] {
  let working = line.trim();
  if (working.startsWith("|")) {
    working = working.slice(1);
  }
  if (working.endsWith("|")) {
    working = working.slice(0, -1);
  }
  return working.split("|").map((cell) => cell.trim());
}

function createToken(replacements: string[], replacement: string): string {
  const token = `TGMARKER${replacements.length}END`;
  replacements.push(replacement);
  return token;
}

function restoreTokens(value: string, replacements: string[]): string {
  let restored = value;
  for (let index = 0; index < replacements.length; index += 1) {
    restored = restored.split(`TGMARKER${index}END`).join(replacements[index] ?? "");
  }
  return restored;
}
