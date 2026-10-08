// markdown.js
// 轻量 Markdown 渲染器（零依赖、纯函数）
//
// 用途：把纯文本 Markdown（例如远程 CHANGELOG.md、外部说明文档）渲染成结构化 HTML。
// 安全策略：先整体转义 HTML，再只放行本模块自己生成的标签，
//          因此远程内容里的 <script> / onerror 等不会被执行。
//
// 支持：标题（ATX / Setext）、粗体、斜体、删除线、行内代码、代码块（带语言类名）、
//      有序/无序列表（含嵌套与任务清单）、引用、分隔线、表格、链接、图片、自动链接。

const ESCAPE_MAP = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;'
};

/** HTML 转义 */
export function escapeHtml(text) {
    return String(text == null ? '' : text).replace(/[&<>"']/g, ch => ESCAPE_MAP[ch]);
}

// 行内代码占位符（用于保护代码片段不被后续行内规则改写）
const CODE_TOKEN = '\u0000';

const CJK_RE = /[\u2E80-\u9FFF\u3000-\u303F\uFF00-\uFFEF\uF900-\uFAFF]/;

function isCjk(ch) {
    return !!ch && CJK_RE.test(ch);
}

/** 只放行安全协议，阻断 javascript:/data: 之类的注入 */
function sanitizeUrl(url) {
    const value = String(url || '').trim();
    if (!value) return '';
    if (/^(https?:\/\/|mailto:|#|\/|\.\/|\.\.\/)/i.test(value)) return value;
    return '';
}

/**
 * 渲染一行内的行内语法。
 * 注意：输入必须是「已经转义过」的文本。
 * 已生成的 HTML（代码、链接、图片）会先存入槽位，避免被后续规则二次改写。
 */
function renderInline(text) {
    let out = escapeHtml(text);
    const slots = [];
    const stash = html => {
        slots.push(html);
        return `${CODE_TOKEN}${slots.length - 1}${CODE_TOKEN}`;
    };

    // 1. 行内代码先摘出来，避免其中的 * _ [ 等被当成语法
    out = out.replace(/`([^`]+)`/g, (match, code) => stash(`<code>${code}</code>`));

    // 2. 图片 ![alt](url)（URL 允许包含成对括号）
    out = out.replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (match, alt, url) => {
        const safe = sanitizeUrl(url);
        if (!safe) return alt;
        return stash(`<img src="${safe}" alt="${alt}" loading="lazy">`);
    });

    // 3. 链接 [文字](url)
    out = out.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g, (match, label, url) => {
        const safe = sanitizeUrl(url);
        if (!safe) return label;
        return stash(`<a href="${safe}" target="_blank" rel="noopener noreferrer">${renderEmphasis(label)}</a>`);
    });

    // 4. 自动链接 &lt;https://example.com&gt;
    out = out.replace(/&lt;((?:https?|mailto):[^\s&]+)&gt;/g, (match, url) => {
        return stash(`<a href="${url}" target="_blank" rel="noopener noreferrer">${url}</a>`);
    });

    // 5. 强调类语法：前置字符不能是字母数字（避免 a*b*c、snake_case 被误判）
    out = renderEmphasis(out);

    // 6. 还原受保护的 HTML 片段
    out = out.replace(new RegExp(`${CODE_TOKEN}(\\d+)${CODE_TOKEN}`, 'g'), (match, index) => {
        return slots[Number(index)] || '';
    });

    return out;
}
/** 只处理强调类语法（粗体 / 斜体 / 删除线），供行内文本与链接文字复用 */
function renderEmphasis(text) {
    return String(text)
        .replace(/\*\*(?=\S)([^*\n]+?)(?<=\S)\*\*/g, '<strong>$1</strong>')
        .replace(/__(?=\S)([^_\n]+?)(?<=\S)__/g, '<strong>$1</strong>')
        .replace(/(^|[^\w*])~~(?=\S)([^~\n]+?)(?<=\S)~~/g, '$1<del>$2</del>')
        .replace(/(^|[^\w*])\*(?=\S)([^*\n]+?)(?<=\S)\*/g, '$1<em>$2</em>')
        .replace(/(^|[^\w*])_(?=\S)([^_\n]+?)(?<=\S)_(?!\w)/g, '$1<em>$2</em>');
}

function headingLevel(rawLevel, offset) {
    const level = Number(rawLevel) + (Number(offset) || 0);
    return Math.min(6, Math.max(2, level));
}

function indentWidth(line) {
    return line.replace(/\t/g, '    ').match(/^\s*/)[0].length;
}

function matchListItem(line) {
    const match = line.match(/^(\s*)([-*+]|\d{1,9}[.)])\s+(.*)$/);
    if (!match) return null;
    return {
        indent: match[1].replace(/\t/g, '    ').length,
        ordered: /\d/.test(match[2]),
        content: match[3]
    };
}

function splitTableRow(line) {
    return line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(cell => cell.trim());
}

function isTableSeparator(line) {
    if (!line || !line.includes('-') || !line.includes('|')) return false;
    const cells = splitTableRow(line);
    return cells.length > 0 && cells.every(cell => /^:?-{2,}:?$/.test(cell));
}

function parseAlignments(line) {
    return splitTableRow(line).map(cell => {
        const left = cell.startsWith(':');
        const right = cell.endsWith(':');
        if (left && right) return 'center';
        if (right) return 'right';
        return 'left';
    });
}

/** 段落内的软换行：中日韩文字之间直接拼接，其余情况补空格，避免英文单词粘连 */
function joinParagraphLine(prev, next) {
    const lastChar = prev.slice(-1);
    const firstChar = next.slice(0, 1);
    if (isCjk(lastChar) && isCjk(firstChar)) return prev + next;
    return `${prev} ${next}`;
}

/** 判断某一行是否会开启新的块级结构（用于段落收集时提前终止） */
function startsBlock(lines, index) {
    const line = lines[index];
    if (!line || !line.trim()) return true;
    if (/^ {0,3}(```+|~~~+)/.test(line)) return true;
    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) return true;
    if (/^ {0,3}#{1,6}\s+/.test(line)) return true;
    if (/^ {0,3}>/.test(line)) return true;
    if (matchListItem(line)) return true;
    if (line.includes('|') && index + 1 < lines.length && isTableSeparator(lines[index + 1])) return true;
    if (index + 1 < lines.length && /^ {0,3}(=+|-+)\s*$/.test(lines[index + 1]) && !matchListItem(line)) return true;
    return false;
}

/** 渲染列表（含嵌套），返回 HTML 与下一行下标 */
function renderList(lines, start, ctx) {
    const first = matchListItem(lines[start]);
    const baseIndent = first.indent;
    const ordered = first.ordered;
    const items = [];
    let i = start;

    while (i < lines.length) {
        const line = lines[i];

        // 空行：后面若还有同级项则继续，否则列表结束
        if (!line.trim()) {
            let j = i + 1;
            while (j < lines.length && !lines[j].trim()) j++;
            const next = j < lines.length ? matchListItem(lines[j]) : null;
            if (next && next.indent === baseIndent && next.ordered === ordered) {
                i = j;
                continue;
            }
            break;
        }

        const item = matchListItem(line);
        if (!item || item.indent !== baseIndent || item.ordered !== ordered) break;

        const block = { text: item.content, sub: [], task: null };
        const taskMatch = block.text.match(/^\[([ xX])\]\s+(.*)$/);
        if (taskMatch) {
            block.task = taskMatch[1].toLowerCase() === 'x';
            block.text = taskMatch[2];
        }
        i++;

        // 收集该项的续行 / 嵌套内容（缩进更深，或非列表的续行）
        const subLines = [];
        while (i < lines.length) {
            const current = lines[i];
            if (!current.trim()) {
                let j = i + 1;
                while (j < lines.length && !lines[j].trim()) j++;
                const deeper = j < lines.length && indentWidth(lines[j]) > baseIndent;
                if (!deeper) break;
                subLines.push('');
                i++;
                continue;
            }
            const nested = matchListItem(current);
            if (nested && nested.indent <= baseIndent) break;
            subLines.push(current);
            i++;
        }

        // 去掉公共缩进后，交给块级解析器递归处理
        const dedent = subLines
            .filter(l => l.trim())
            .reduce((min, l) => Math.min(min, indentWidth(l)), Infinity);
        block.sub = subLines.map(l => (l.trim() ? l.slice(Number.isFinite(dedent) ? dedent : 0) : ''));
        items.push(block);
    }

    const tag = ordered ? 'ol' : 'ul';
    const html = items.map(block => {
        const parts = [];
        if (block.task !== null) {
            parts.push(`<span class="qr-md-task${block.task ? ' is-done' : ''}" aria-hidden="true"></span>`);
        }
        if (block.text) parts.push(renderInline(block.text));
        if (block.sub.length) {
            const nested = renderBlocks(block.sub, ctx);
            if (nested) parts.push(nested);
        }
        return `<li>${parts.join('')}</li>`;
    }).join('');

    return { html: `<${tag}>${html}</${tag}>`, next: i };
}

/** 渲染表格 */
function renderTable(lines, start) {
    const headers = splitTableRow(lines[start]);
    const aligns = parseAlignments(lines[start + 1]);
    let i = start + 2;
    const rows = [];
    while (i < lines.length && lines[i].trim() && lines[i].includes('|')) {
        rows.push(splitTableRow(lines[i]));
        i++;
    }

    const alignAttr = index => {
        const align = aligns[index];
        return align && align !== 'left' ? ` style="text-align:${align}"` : '';
    };

    const headHtml = headers.map((cell, index) => `<th${alignAttr(index)}>${renderInline(cell)}</th>`).join('');
    const bodyHtml = rows.map(row => {
        const cells = headers.map((_, index) => `<td${alignAttr(index)}>${renderInline(row[index] || '')}</td>`).join('');
        return `<tr>${cells}</tr>`;
    }).join('');

    return {
        html: `<table><thead><tr>${headHtml}</tr></thead><tbody>${bodyHtml}</tbody></table>`,
        next: i
    };
}

function renderBlocks(lines, ctx) {
    const out = [];
    let i = 0;

    while (i < lines.length) {
        const line = lines[i];

        if (!line.trim()) {
            i++;
            continue;
        }

        // --- 围栏代码块 ---
        const fence = line.match(/^ {0,3}(```+|~~~+)\s*([\w+#.-]*)\s*$/);
        if (fence) {
            const marker = fence[1][0];
            const lang = fence[2];
            const closing = new RegExp(`^ {0,3}${marker}{3,}\\s*$`);
            const buffer = [];
            i++;
            while (i < lines.length && !closing.test(lines[i])) {
                buffer.push(lines[i]);
                i++;
            }
            i++; // 跳过结束围栏
            const cls = lang ? ` class="language-${escapeHtml(lang)}"` : '';
            out.push(`<pre><code${cls}>${escapeHtml(buffer.join('\n'))}</code></pre>`);
            continue;
        }

        // --- 分隔线 ---
        if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) {
            out.push('<hr>');
            i++;
            continue;
        }

        // --- ATX 标题 ---
        const heading = line.match(/^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/);
        if (heading) {
            const level = headingLevel(heading[1].length, ctx.headingOffset);
            out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
            i++;
            continue;
        }

        // --- Setext 标题 ---
        if (i + 1 < lines.length && line.trim() && /^ {0,3}(=+|-+)\s*$/.test(lines[i + 1]) && !matchListItem(line)) {
            const base = lines[i + 1].trim()[0] === '=' ? 2 : 3;
            const level = headingLevel(base, ctx.headingOffset);
            out.push(`<h${level}>${renderInline(line.trim())}</h${level}>`);
            i += 2;
            continue;
        }

        // --- 引用 ---
        if (/^ {0,3}>/.test(line)) {
            const buffer = [];
            while (i < lines.length && /^ {0,3}>/.test(lines[i])) {
                buffer.push(lines[i].replace(/^ {0,3}>\s?/, ''));
                i++;
            }
            out.push(`<blockquote>${renderBlocks(buffer, ctx)}</blockquote>`);
            continue;
        }

        // --- 表格 ---
        if (line.includes('|') && i + 1 < lines.length && isTableSeparator(lines[i + 1])) {
            const table = renderTable(lines, i);
            out.push(table.html);
            i = table.next;
            continue;
        }

        // --- 列表 ---
        if (matchListItem(line)) {
            const list = renderList(lines, i, ctx);
            out.push(list.html);
            i = list.next;
            continue;
        }

        // --- 段落 ---
        const paragraph = [line.trim()];
        i++;
        while (i < lines.length && lines[i].trim() && !startsBlock(lines, i)) {
            paragraph.push(lines[i].trim());
            i++;
        }
        const text = paragraph.reduce((acc, cur) => joinParagraphLine(acc, cur));
        out.push(`<p>${renderInline(text)}</p>`);
    }

    return out.join('\n');
}

/**
 * 渲染 Markdown 文本为 HTML 字符串。
 * @param {string} source Markdown 原文
 * @param {{headingOffset?: number}} [options] headingOffset：标题级别整体下调（例如弹窗里 # 变成 h3）
 */
export function renderMarkdown(source, options = {}) {
    const text = String(source == null ? '' : source).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
    if (!text.trim()) return '';
    return renderBlocks(text.split('\n'), { headingOffset: options.headingOffset || 0 }).trim();
}
