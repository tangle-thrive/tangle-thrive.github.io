exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { topic, studentClass, excludeUrl } = JSON.parse(event.body);
    const isCleaveland = studentClass === 'Ms. Cleaveland';
    const isGomez      = studentClass === 'Mr. Gomez';
    const gradeLevel   = isGomez ? '6th grade' : '4th–5th grade (reading level closer to 2nd–3rd grade)';

    // Normalize topic: strip location qualifiers so searches work better
    // e.g. "homelessness in my city" → "homelessness"
    const normalizedTopic = topic
        .replace(/\s+in\s+(my|our|the)\s+\w+/gi, '')
        .trim();

    // ── Serper search on dogonews.com ────────────────────────────────────
    let searchResults = [];
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        try {
            const res = await fetch('https://google.serper.dev/search', {
                method: 'POST',
                headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ q: `${normalizedTopic} site:dogonews.com`, num: 10 }),
                signal: controller.signal
            });
            const data = await res.json();
            searchResults = (data.organic || [])
                .map(r => ({ title: r.title, url: r.link, snippet: r.snippet || '' }))
                .filter(r => r.url && (!excludeUrl || r.url !== excludeUrl));
            console.log(`Serper dogonews: ${searchResults.length} results for "${normalizedTopic}"`);
        } finally {
            clearTimeout(timer);
        }
    } catch (e) {
        console.error('Serper failed:', e.message);
    }

    const activityFormat = `{ "type": "activity", "title": "...", "summary": "1 sentence", "steps": ["Step 1: ...", "Step 2: ...", "Step 3: ..."] }`;
    const articleFormat  = `{ "type": "article", "title": "...", "siteName": "Dogo News", "url": "exact URL from search results", "summary": "1 sentence for kids" }`;

    const resultsText = searchResults.length > 0
        ? searchResults.map((r, i) => `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Snippet: ${r.snippet}`).join('\n\n')
        : null;

    let prompt;
    if (isCleaveland) {
        prompt = `You are helping a teacher assign at-home content for ${gradeLevel} students who care about: "${normalizedTopic}".

${resultsText ? `Dogo News search results:\n${resultsText}` : 'No search results available.'}

Return exactly 2 suggestions:
1. ${resultsText ? `ARTICLE — pick the most relevant result above that is directly about "${normalizedTopic}" as a social issue or community problem. Use the exact URL from the results.` : `ACTIVITY — connected to "${normalizedTopic}"`}
2. ACTIVITY — a simple hands-on activity a student can do at home. Good types: make an awareness poster, write a short speech, write a letter to someone who can help, draw a comic strip, create a fact card, make a "Did You Know?" sign.

Rules:
- Article must be DIRECTLY about the social issue (e.g. hunger → food insecurity, hunger relief — NOT cooking or gardening).
- Activity: basic supplies only (paper, pencil, markers). Exactly 3 steps, each starting with an action verb.
- NEVER invent URLs. Use only URLs from the search results above.

JSON only — no other text:
{
  "suggestions": [
    ${resultsText ? articleFormat : activityFormat},
    ${activityFormat}
  ]
}`;
    } else {
        prompt = `You are helping a teacher assign at-home reading for ${gradeLevel} students who care about: "${normalizedTopic}".

${resultsText ? `Dogo News search results:\n${resultsText}` : 'No search results available.'}

${resultsText
    ? `Return the 2 most relevant results above that are directly about "${normalizedTopic}" as a social issue or community problem. Use the exact URLs from the results.`
    : `No articles available.`}

Rules:
- Articles must be DIRECTLY about the social issue — not loosely related content.
- 1-sentence summary per article, engaging tone for 6th graders.
- NEVER invent URLs. Use only URLs from the search results above.

JSON only — no other text:
{
  "suggestions": [
    ${articleFormat},
    ${articleFormat}
  ]
}`;
    }

    // ── Call Claude ───────────────────────────────────────────────────────
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 7000);
        let claudeData;
        try {
            const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
                method: 'POST',
                headers: {
                    'x-api-key': process.env.CLAUDE_API_KEY,
                    'anthropic-version': '2023-06-01',
                    'content-type': 'application/json'
                },
                body: JSON.stringify({
                    model: 'claude-haiku-4-5-20251001',
                    max_tokens: 800,
                    messages: [{ role: 'user', content: prompt }]
                }),
                signal: controller.signal
            });
            claudeData = await claudeRes.json();
        } finally {
            clearTimeout(timer);
        }

        const text = claudeData.content?.[0]?.text || '';
        console.log('Claude error:', claudeData.error?.message);
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON from Claude: ' + text.slice(0, 200));
        const parsed = JSON.parse(jsonMatch[0]);
        console.log('Suggestions:', JSON.stringify(parsed.suggestions?.map(s => ({ type: s.type, title: s.title, url: s.url }))));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed)
        };

    } catch (err) {
        console.error('Claude failed:', err.message);
    }

    // ── Last-resort fallback ─────────────────────────────────────────────
    if (isGomez) {
        // Gomez: ask student to find their own article
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ suggestions: [
                { type: 'search-prompt', topic: normalizedTopic }
            ]})
        };
    }

    // Cleaveland: two distinct at-home activities
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestions: [
            {
                type: 'activity',
                title: `Make an Awareness Poster About ${normalizedTopic}`,
                summary: `Create a colorful poster that teaches others about ${normalizedTopic} and what people can do to help.`,
                steps: [
                    `Write "${normalizedTopic}" in big letters at the top of your paper.`,
                    `Draw a picture in the middle that shows the problem and how it affects people.`,
                    `Add 2–3 ideas at the bottom for how someone can help, then decorate with colors.`
                ]
            },
            {
                type: 'activity',
                title: `Write a Letter About ${normalizedTopic}`,
                summary: `Write a short letter to a family member, teacher, or local leader about why ${normalizedTopic} matters.`,
                steps: [
                    `Start with "Dear ___," and write 1–2 sentences explaining what ${normalizedTopic} is.`,
                    `Write 1–2 sentences about why this issue matters to you personally.`,
                    `End with one idea for how they could help, then sign your name.`
                ]
            }
        ]})
    };
};
