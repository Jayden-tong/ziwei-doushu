import { NextRequest } from 'next/server';
import type { ZiweiChart, Palace, Star } from '@/lib/ziwei/types';
import { detectPatterns, getMingGongSummary } from '@/lib/ziwei/patterns';

type ChatMessage = {
  role: 'user' | 'assistant';
  content: string;
};

const encoder = new TextEncoder();

export const runtime = 'nodejs';

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();
    const chart = body.chart as ZiweiChart | undefined;
    const messages = (body.messages ?? []) as ChatMessage[];

    if (!chart || !Array.isArray(chart.palaces)) {
      return Response.json({ error: '缺少命盘数据' }, { status: 400 });
    }

    const text = buildLocalInterpretation(chart, messages);

    const stream = new ReadableStream({
      async start(controller) {
        for (const chunk of splitText(text)) {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify({ delta: { text: chunk } })}\n\n`));
          await new Promise(resolve => setTimeout(resolve, 8));
        }
        controller.enqueue(encoder.encode('data: [DONE]\n\n'));
        controller.close();
      },
    });

    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
      },
    });
  } catch (error) {
    return Response.json({ error: '解读生成失败' }, { status: 500 });
  }
}

function buildLocalInterpretation(chart: ZiweiChart, messages: ChatMessage[]) {
  const prompt = messages[messages.length - 1]?.content ?? '';
  const topic = detectTopic(prompt);
  const ming = findPalace(chart, '命宫') ?? chart.palaces.find(p => p.branch === chart.mingGongBranch);
  const cai = findPalace(chart, '财帛');
  const guan = findPalace(chart, '官禄');
  const qian = findPalace(chart, '迁移');
  const fuqi = findPalace(chart, '夫妻');
  const jier = findPalace(chart, '疾厄');
  const summary = getMingGongSummary(chart);
  const patterns = detectPatterns(chart).slice(0, 4);
  const currentDaXian = chart.daXians?.[chart.currentDaXianIndex];

  if (topic === 'love') {
    return [
      '**【感情格局】**',
      `夫妻宫为${describePalace(fuqi)}。感情判断要同时看夫妻宫、命宫与福德宫，这里先给基础结构分析。`,
      '',
      '**【夫妻宫分析】**',
      palaceDetail(fuqi),
      '',
      '**【实际建议】**',
      '这版为本地基础解读，适合先判断宫位与星曜结构。后续接入大模型后，可以进一步结合大限、流年与具体问题做细化分析。',
    ].join('\n');
  }

  if (topic === 'career') {
    return [
      '**【事业格局】**',
      `官禄宫为${describePalace(guan)}，财帛宫为${describePalace(cai)}。事业要看官禄定方向，财帛看收入方式，迁移看外部机会。`,
      '',
      '**【官禄宫分析】**',
      palaceDetail(guan),
      '',
      '**【财帛宫联动】**',
      palaceDetail(cai),
      '',
      '**【实际建议】**',
      buildAdvice([guan, cai, qian]),
    ].join('\n');
  }

  if (topic === 'wealth') {
    return [
      '**【财运格局】**',
      `财帛宫为${describePalace(cai)}。财运不是只看有没有财星，还要看能不能守、是否受煞星或化忌影响。`,
      '',
      '**【财帛宫分析】**',
      palaceDetail(cai),
      '',
      '**【理财建议】**',
      buildAdvice([cai, findPalace(chart, '田宅'), ming]),
    ].join('\n');
  }

  if (topic === 'health') {
    return [
      '**【疾厄宫主星】**',
      `疾厄宫为${describePalace(jier)}。健康分析只能做倾向提醒，不能替代医学诊断。`,
      '',
      '**【主要风险】**',
      palaceDetail(jier),
      '',
      '**【预防建议】**',
      '保持规律作息，身体不适以正规医院检查为准。后续接入大模型后，可以把疾厄宫、流年和具体症状分开做更细的提示。',
    ].join('\n');
  }

  if (topic === 'personality') {
    return [
      '**【命宫主星性格】**',
      `命宫主星：${summary.stars.length ? summary.stars.join('、') : '空宫借对宫'}。核心关键词：${summary.keywords.length ? summary.keywords.join('、') : '需结合对宫与三方四正'}。`,
      '',
      '**【三方性格综合】**',
      `命宫为${describePalace(ming)}。财帛宫为${describePalace(cai)}，官禄宫为${describePalace(guan)}，迁移宫为${describePalace(qian)}。`,
      '',
      '**【优势与人生课题】**',
      buildAdvice([ming, cai, guan, qian]),
    ].join('\n');
  }

  return [
    '**【命格定性】**',
    `命宫主星：${summary.stars.length ? summary.stars.join('、') : '空宫借对宫'}。五行局为${chart.wuxingJuName}，当前年龄约${chart.currentAge}岁。`,
    '',
    '**【主星解读】**',
    palaceDetail(ming),
    '',
    '**【三方四正】**',
    `财帛宫：${describePalace(cai)}。官禄宫：${describePalace(guan)}。迁移宫：${describePalace(qian)}。这三宫与命宫共同决定做事方式、资源来源和外部机会。`,
    '',
    '**【当前大限】**',
    currentDaXian
      ? `当前大限约为${currentDaXian.startAge}-${currentDaXian.endAge}岁，落${currentDaXian.palaceName}。这十年重点会围绕该宫所代表的人生领域展开。`
      : '当前大限资料暂未识别。',
    '',
    '**【格局提示】**',
    patterns.length
      ? patterns.map(p => `- ${p.name}：${p.description}`).join('\n')
      : '暂未识别到明显成格，建议以命宫、财官迁三方四正的结构为主来分析。',
    '',
    '**【说明】**',
    '这是本地基础解读，不依赖大模型。正式上线时建议接入大模型，让它结合样本库和你的解读体系生成更完整报告。',
  ].join('\n');
}

function detectTopic(prompt: string) {
  if (prompt.includes('感情') || prompt.includes('夫妻') || prompt.includes('婚姻')) return 'love';
  if (prompt.includes('事业') || prompt.includes('官禄') || prompt.includes('职业')) return 'career';
  if (prompt.includes('财') || prompt.includes('财富') || prompt.includes('财帛')) return 'wealth';
  if (prompt.includes('健康') || prompt.includes('疾厄')) return 'health';
  if (prompt.includes('性格') || prompt.includes('特质')) return 'personality';
  return 'overview';
}

function findPalace(chart: ZiweiChart, name: string) {
  return chart.palaces.find(p => p.name === name || p.name === `${name}宫`);
}

function describePalace(palace?: Palace) {
  if (!palace) return '暂未识别';
  const majorStars = palace.stars.filter(s => s.type === 'major');
  const stars = majorStars.length ? majorStars : palace.stars.slice(0, 5);
  if (!stars.length) return `${palace.name}空宫${palace.borrowedStars?.length ? `，借对宫${palace.borrowedStars.join('、')}` : ''}`;
  return `${palace.name}坐${stars.map(formatStar).join('、')}`;
}

function palaceDetail(palace?: Palace) {
  if (!palace) return '暂未识别该宫位资料。';
  const stars = palace.stars.length ? palace.stars.map(formatStar).join('、') : '无主星';
  const selfSihua = palace.selfSihua?.length
    ? `宫干自化：${palace.selfSihua.map(s => `${s.starName}自化${s.siHua}`).join('、')}。`
    : '';
  const empty = palace.isEmpty
    ? `此宫为空宫，需借对宫${palace.borrowedFromName ?? ''}${palace.borrowedStars?.length ? `（${palace.borrowedStars.join('、')}）` : ''}来参考。`
    : '';
  return `${palace.name}星曜：${stars}。${empty}${selfSihua}`;
}

function formatStar(star: Star) {
  return `${star.name}${star.siHua ? `化${star.siHua}` : ''}${star.brightness === 'bright' ? '（庙旺）' : star.brightness === 'dim' ? '（落陷）' : ''}`;
}

function buildAdvice(palaces: Array<Palace | undefined>) {
  const hasJi = palaces.some(p => p?.stars.some(s => s.siHua === '忌'));
  const hasLu = palaces.some(p => p?.stars.some(s => s.siHua === '禄'));
  const hasSha = palaces.some(p => p?.stars.some(s => s.type === 'sha'));
  const lines = [
    hasLu ? '有化禄参与的领域，可以优先作为资源、机会和顺势推进的方向。' : '目前基础结构里未看到明显化禄提示，宜先稳住节奏，避免只凭冲动推进。',
    hasJi ? '有化忌参与的领域，容易成为压力点，需要提前做计划和风险控制。' : '未见明显化忌集中，整体可按常规节奏推进。',
    hasSha ? '煞星参与时，行动力强但波动也大，宜把规则、合同、健康和现金流提前安排清楚。' : '煞星压力不重时，适合用长期积累换稳定结果。',
  ];
  return lines.join('\n');
}

function splitText(text: string) {
  const chunks: string[] = [];
  let current = '';
  for (const char of text) {
    current += char;
    if (current.length >= 16 || /[。！？\n]/.test(char)) {
      chunks.push(current);
      current = '';
    }
  }
  if (current) chunks.push(current);
  return chunks;
}
