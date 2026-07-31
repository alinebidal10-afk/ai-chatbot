import React from "react";

/**
 * Tiny, dependency-free renderer for the light markdown the model produces:
 * [links](url), **bold**, `code`, "- " bullet lists and paragraphs.
 */

function renderInline(text: string, keyPrefix: string): React.ReactNode[] {
  const nodes: React.ReactNode[] = [];
  // links | bold | inline code | bare URLs
  const re =
    /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|\*\*([^*]+)\*\*|`([^`]+)`|(https?:\/\/[^\s<>")\]]+)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) nodes.push(text.slice(last, m.index));
    const key = `${keyPrefix}-${i++}`;
    if (m[1] && m[2]) {
      nodes.push(
        <a
          key={key}
          href={m[2]}
          target="_blank"
          rel="noopener noreferrer"
          className="font-medium text-cat-outline underline underline-offset-2 hover:opacity-80"
        >
          {m[1]}
        </a>,
      );
    } else if (m[3]) {
      nodes.push(<strong key={key}>{m[3]}</strong>);
    } else if (m[4]) {
      nodes.push(
        <code key={key} className="rounded bg-ink/10 px-1 py-0.5 text-[0.9em]">
          {m[4]}
        </code>,
      );
    } else if (m[5]) {
      nodes.push(
        <a
          key={key}
          href={m[5]}
          target="_blank"
          rel="noopener noreferrer"
          className="break-all font-medium text-cat-outline underline underline-offset-2 hover:opacity-80"
        >
          {m[5]}
        </a>,
      );
    }
    last = re.lastIndex;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function Markdown({ text }: { text: string }) {
  const blocks: React.ReactNode[] = [];
  const lines = text.split("\n");
  let list: string[] = [];
  let key = 0;

  const flushList = () => {
    if (list.length === 0) return;
    blocks.push(
      <ul key={`ul-${key++}`} className="my-1 list-disc space-y-1 pl-5">
        {list.map((item, i) => (
          <li key={i}>{renderInline(item, `li-${key}-${i}`)}</li>
        ))}
      </ul>,
    );
    list = [];
  };

  for (const line of lines) {
    const bullet = line.match(/^\s*[-*]\s+(.*)$/);
    if (bullet) {
      list.push(bullet[1]);
      continue;
    }
    flushList();
    const heading = line.match(/^#{1,4}\s+(.*)$/);
    if (heading) {
      blocks.push(
        <p key={`h-${key++}`} className="mt-2 font-medium">
          {renderInline(heading[1], `h-${key}`)}
        </p>,
      );
    } else if (line.trim() === "") {
      blocks.push(<div key={`sp-${key++}`} className="h-2" />);
    } else {
      blocks.push(
        <p key={`p-${key++}`} className="whitespace-pre-wrap">
          {renderInline(line, `p-${key}`)}
        </p>,
      );
    }
  }
  flushList();

  return <div className="space-y-0.5 leading-relaxed">{blocks}</div>;
}

// Memoised so finished messages are not re-parsed and re-rendered on every
// frame while a new one streams beneath them.
export default React.memo(Markdown);
