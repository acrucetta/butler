const CODE_BLOCK_PATTERN = /```([^\n`]*)\n?([\s\S]*?)```/g;
const INLINE_CODE_PATTERN = /`([^`\n]+?)`/g;
const LINK_PATTERN = /\[([^\]\n]+)\]\(([^)\s]+)\)/g;
const HEADING_PATTERN = /^\s*#{1,6}\s+(.+)$/;
const BULLET_PATTERN = /^\s*[-*]\s+(.+)$/;
const ORDERED_LIST_PATTERN = /^\s*(\d+)\.\s+(.+)$/;
const MARKDOWN_V2_ESCAPE_PATTERN = /[_*[\]()~`>#+\-=|{}.!]/g;

export function toTelegramMarkdownV2(markdown: string): string {
  const replacements: string[] = [];
  let working = markdown.replace(/\r\n?/g, "\n");

  working = working.replace(CODE_BLOCK_PATTERN, (_match, language: string, code: string) =>
    createToken(replacements, renderCodeBlock(language, code))
  );

  working = working.replace(INLINE_CODE_PATTERN, (_match, code: string) =>
    createToken(replacements, renderInlineCode(code))
  );

  working = working.replace(LINK_PATTERN, (_match, label: string, url: string) =>
    createToken(replacements, renderLink(label, url))
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
