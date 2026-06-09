import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createHash } from 'node:crypto';

const BASE_URL = 'https://wdyziweidoushu666.com';
const START_URL = `${BASE_URL}/knowledge`;
const OUT_DIR = path.resolve('data/authorized/wdy-knowledge');
const RAW_DIR = path.join(OUT_DIR, 'raw-pages');
const REQUEST_DELAY_MS = 160;

const SECTION_LABELS = ['一句话定调', '核心论断', '命盘依据', '经典出处'];

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function decodeEntities(input) {
  return input
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, num) => String.fromCodePoint(parseInt(num, 10)))
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'");
}

function stripHash(href) {
  return href.split('#')[0];
}

function normalizePath(href) {
  if (!href) return '';
  const url = href.startsWith('http') ? new URL(href) : new URL(href, BASE_URL);
  if (url.origin !== BASE_URL) return '';
  return stripHash(url.pathname);
}

function pagePathToFilename(pagePath) {
  const safe = pagePath.replace(/^\/+/, '').replace(/[/?#:&=]+/g, '__') || 'index';
  return `${safe}.html`;
}

async function fetchText(url) {
  const response = await fetch(url, {
    headers: {
      'user-agent': 'Codex authorized knowledge backup; contact site owner via requester',
      accept: 'text/html,application/xhtml+xml',
    },
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status} ${response.statusText} for ${url}`);
  }
  return response.text();
}

function extractKnowledgeLinks(html) {
  const links = new Set(['/knowledge']);
  const hrefRe = /href="([^"]*\/knowledge[^"]*)"/g;
  let match;
  while ((match = hrefRe.exec(html)) !== null) {
    const pagePath = normalizePath(match[1]);
    if (pagePath.startsWith('/knowledge')) links.add(pagePath);
  }
  return [...links].sort();
}

function getMeta(html, name) {
  const byName = new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`, 'i').exec(html);
  if (byName) return decodeEntities(byName[1]).trim();
  const byProperty = new RegExp(`<meta\\s+property="${name}"\\s+content="([^"]*)"`, 'i').exec(html);
  return byProperty ? decodeEntities(byProperty[1]).trim() : '';
}

function getTitle(html) {
  const title = /<title>([\s\S]*?)<\/title>/i.exec(html)?.[1] ?? '';
  return decodeEntities(title).trim();
}

function getArticleHtml(html) {
  return /<article\b[\s\S]*?<\/article>/i.exec(html)?.[0] ?? '';
}

function htmlToText(html) {
  return decodeEntities(
    html
      .replace(/<script\b[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[\s\S]*?<\/style>/gi, '')
      .replace(/<!--[\s\S]*?-->/g, '')
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|section|article|header|nav|h1|h2|h3|li)>/gi, '\n')
      .replace(/<[^>]+>/g, '')
  )
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n[ \t]+/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function compactLines(text) {
  return text
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
}

function extractSections(lines) {
  const sections = {};
  for (const block of extractSectionBlocks(lines)) {
    if (!sections[block.label]) sections[block.label] = block.body;
  }
  return sections;
}

function isSectionBoundary(line) {
  return (
    line.includes('想看你') ||
    line.includes('立即起盘') ||
    line.includes('其他主星') ||
    line.includes('其他双星') ||
    line.includes('其他中格') ||
    line.includes('其他上格') ||
    line === '上格' ||
    line === '助力格' ||
    line === '恶格' ||
    line === '基础格局' ||
    line.includes('涉及星曜') ||
    /^.+入.+宫$/.test(line)
  );
}

function extractSectionBlocks(lines) {
  const blocks = [];
  for (let i = 0; i < lines.length; i += 1) {
    const label = SECTION_LABELS.find(item => lines[i] === item);
    if (!label) continue;
    const body = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      if (SECTION_LABELS.includes(lines[j])) break;
      if (body.length > 0 && isSectionBoundary(lines[j])) break;
      body.push(lines[j]);
    }
    blocks.push({
      label,
      body: body.join('\n').trim(),
      heading: findNearestHeading(lines, i),
    });
  }
  return blocks;
}

function findNearestHeading(lines, index) {
  for (let i = index - 1; i >= 0; i -= 1) {
    const line = lines[i];
    if (SECTION_LABELS.includes(line)) continue;
    if (line.length > 40) continue;
    if (line.includes('/') || line.includes('首页') || line.includes('知识库')) continue;
    return line;
  }
  return '';
}

function parsePageType(pagePath) {
  if (pagePath === '/knowledge') return { type: 'index' };
  const parts = pagePath.split('/').filter(Boolean);
  if (parts[1] === 'combo') return { type: 'combo', slug: parts[2] };
  if (parts[1] === 'pattern') return { type: 'pattern', slug: parts[2] };
  return { type: 'star', starSlug: parts[1], topic: parts[2] };
}

function parseEntry(pagePath, html) {
  const articleHtml = getArticleHtml(html);
  const articleText = htmlToText(articleHtml);
  const lines = compactLines(articleText);
  const metadata = {
    path: pagePath,
    url: `${BASE_URL}${pagePath}`,
    title: getTitle(html),
    description: getMeta(html, 'description') || getMeta(html, 'og:description'),
    sha256: createHash('sha256').update(html).digest('hex'),
  };

  return {
    ...metadata,
    ...parsePageType(pagePath),
    h1: lines.find(line => line.length <= 30 && !line.includes('/') && !line.includes('首页')) ?? '',
    sections: extractSections(lines),
    sectionBlocks: extractSectionBlocks(lines),
    text: articleText,
  };
}

function groupStarDb(entries) {
  const topicToField = {
    overview: 'mingGong',
    personality: 'personality',
    love: 'fuQi',
    career: 'guanLu',
    wealth: 'caiBo',
    health: 'jiE',
    family: 'xiongDi',
    children: 'ziNv',
    move: 'qianYi',
    friends: 'jiaoYou',
    home: 'tianZhai',
    spirit: 'fuDe',
    parents: 'fuMu',
  };
  const slugToStar = {
    ziwei: '紫微',
    tianji: '天机',
    taiyang: '太阳',
    wuqu: '武曲',
    tiantong: '天同',
    lianzhen: '廉贞',
    tianfu: '天府',
    taiyin: '太阴',
    tanlang: '贪狼',
    jumen: '巨门',
    tianxiang: '天相',
    tianliang: '天梁',
    qisha: '七杀',
    pojun: '破军',
  };
  const starDb = {};
  for (const entry of entries) {
    if (entry.type !== 'star') continue;
    const star = slugToStar[entry.starSlug];
    const field = topicToField[entry.topic];
    if (!star || !field) continue;
    starDb[star] ??= {};
    starDb[star][field] = [
      `**【一句话定调】**\n${entry.sections['一句话定调'] ?? ''}`,
      `**【核心论断】**\n${entry.sections['核心论断'] ?? ''}`,
      `**【命盘依据】**\n${entry.sections['命盘依据'] ?? ''}`,
      `**【经典出处】**\n${entry.sections['经典出处'] ?? ''}`,
    ].join('\n\n').trim();
  }
  return starDb;
}

async function main() {
  await mkdir(RAW_DIR, { recursive: true });

  const indexHtml = await fetchText(START_URL);
  await writeFile(path.join(RAW_DIR, pagePathToFilename('/knowledge')), indexHtml, 'utf8');

  const links = extractKnowledgeLinks(indexHtml);
  const entries = [];
  const failures = [];

  for (let i = 0; i < links.length; i += 1) {
    const pagePath = links[i];
    try {
      let html;
      if (pagePath === '/knowledge') {
        html = indexHtml;
      } else {
        await sleep(REQUEST_DELAY_MS);
        html = await fetchText(`${BASE_URL}${pagePath}`);
        await writeFile(path.join(RAW_DIR, pagePathToFilename(pagePath)), html, 'utf8');
      }
      entries.push(parseEntry(pagePath, html));
      process.stdout.write(`(${i + 1}/${links.length}) ok ${pagePath}\n`);
    } catch (error) {
      failures.push({ path: pagePath, error: error.message });
      process.stdout.write(`(${i + 1}/${links.length}) fail ${pagePath}: ${error.message}\n`);
    }
  }

  const manifest = {
    source: START_URL,
    fetchedAt: new Date().toISOString(),
    authorizationNote: 'Requester stated the site author is a friend and granted permission to use the knowledge pages.',
    counts: {
      totalLinks: links.length,
      fetched: entries.length,
      failed: failures.length,
      starPages: entries.filter(entry => entry.type === 'star').length,
      comboPages: entries.filter(entry => entry.type === 'combo').length,
      patternPages: entries.filter(entry => entry.type === 'pattern').length,
    },
    failures,
  };

  await writeFile(path.join(OUT_DIR, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8');
  await writeFile(path.join(OUT_DIR, 'knowledge-pages.json'), JSON.stringify(entries, null, 2), 'utf8');
  await writeFile(path.join(OUT_DIR, 'star-db.json'), JSON.stringify(groupStarDb(entries), null, 2), 'utf8');

  const summary = [
    '# WDY Authorized Knowledge Backup',
    '',
    `Source: ${START_URL}`,
    `Fetched at: ${manifest.fetchedAt}`,
    '',
    'Authorization note: requester stated the site author granted permission to use the knowledge pages.',
    '',
    `Fetched pages: ${manifest.counts.fetched}`,
    `Star pages: ${manifest.counts.starPages}`,
    `Combo pages: ${manifest.counts.comboPages}`,
    `Pattern pages: ${manifest.counts.patternPages}`,
    `Failures: ${manifest.counts.failed}`,
    '',
    'Files:',
    '- raw-pages/: original HTML backup',
    '- knowledge-pages.json: parsed page text and sections',
    '- star-db.json: 14-star pages grouped for this project schema',
  ].join('\n');
  await writeFile(path.join(OUT_DIR, 'README.md'), `${summary}\n`, 'utf8');

  console.log(JSON.stringify(manifest, null, 2));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
