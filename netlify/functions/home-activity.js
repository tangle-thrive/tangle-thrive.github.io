exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { topic, studentClass } = JSON.parse(event.body);
    const isCleaveland = studentClass === 'Ms. Cleaveland';
    const isGomez      = studentClass === 'Mr. Gomez';
    const gradeDesc    = isGomez
        ? '6th grade students'
        : '4th and 5th grade students who read below grade level (roughly 2nd–3rd grade reading level)';

    // Helper: run Serper search with a timeout
    const serperSearch = async (q) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        try {
            const res = await fetch('https://google.serper.dev/search', {
                method: 'POST',
                headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ q, num: 8 }),
                signal: controller.signal
            });
            const data = await res.json();
            return (data.organic || []).slice(0, 8).map(r => {
                let siteName = '';
                try { siteName = new URL(r.link).hostname.replace('www.', ''); } catch(e) {}
                return { title: r.title, url: r.link, snippet: r.snippet || '', siteName };
            });
        } finally {
            clearTimeout(timer);
        }
    };

    // ── 1. Try Serper ────────────────────────────────────────────────────
    let searchResults = [];
    try {
        searchResults = await serperSearch(
            `${topic} for kids site:pbslearningmedia.org OR site:wonderopolis.org OR site:dogonews.com OR site:kids.nationalgeographic.com`
        );
        console.log(`Serper returned ${searchResults.length} results for: ${topic}`);
        // Broaden if too few
        if (searchResults.length < 2) {
            const broader = await serperSearch(`${topic} kids article reading`);
            searchResults = [...searchResults, ...broader].slice(0, 8);
            console.log(`Broader search total: ${searchResults.length}`);
        }
    } catch (e) {
        console.error('Serper failed:', e.message);
    }

    // ── 2. Build Claude prompt ───────────────────────────────────────────
    const hasResults = searchResults.length > 0;
    const resultsText = hasResults
        ? searchResults.map((r, i) =>
            `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Site: ${r.siteName}\n   Snippet: ${r.snippet}`
          ).join('\n\n')
        : null;

    let prompt;
    if (isCleaveland) {
        prompt = `You are helping a teacher find at-home content for ${gradeDesc}. Student's issue: "${topic}".

${hasResults
    ? `Search results:\n${resultsText}\n\nReturn 2 suggestions:\n1. ARTICLE — best from search results only. Use the exact URL from search results above.\n2. ACTIVITY — simple hands-on activity connected to "${topic}".`
    : `No search results. Return 2 ACTIVITY suggestions connected to "${topic}".`
}

Activity options (pick the best fit): make a poster, write a short speech, write a letter, draw a comic strip, create a fact card, make a "Did You Know?" sign.
Rules: simple language (2nd–3rd grade level), 1-sentence summary, 2–3 sentence instructions, basic supplies only. NEVER invent URLs.

JSON only:
{
  "suggestions": [
    { "type": "article", "title": "...", "siteName": "...", "url": "...", "summary": "..." },
    { "type": "activity", "title": "...", "summary": "...", "instructions": "..." }
  ]
}`;
    } else {
        prompt = `You are helping a teacher find 2 at-home articles for ${gradeDesc}. Student's issue: "${topic}".

${hasResults
    ? `Search results:\n${resultsText}\n\nReturn the 2 best articles from the search results above. Use the exact URLs from the list above only.`
    : `No search results. Suggest 2 real articles from wonderopolis.org or dogonews.com that you are highly confident exist and relate to "${topic}" or community action / helping others. Use real slugs you know are correct (e.g. wonderopolis.org/wonder/[slug]).`
}

Rules: 1-sentence summary, engaging tone. NEVER invent URLs you are not confident exist.

JSON only:
{
  "suggestions": [
    { "type": "article", "title": "...", "siteName": "...", "url": "...", "summary": "..." },
    { "type": "article", "title": "...", "siteName": "...", "url": "...", "summary": "..." }
  ]
}`;
    }

    // ── 3. Call Claude (with timeout) ────────────────────────────────────
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
        console.log('Claude status:', claudeData.type, '| stop_reason:', claudeData.stop_reason, '| error:', claudeData.error?.message);
        console.log('Claude text (first 300):', text.slice(0, 300));
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in Claude response');
        const parsed = JSON.parse(jsonMatch[0]);

        console.log('Returning suggestions:', JSON.stringify(parsed.suggestions?.map(s => ({ type: s.type, title: s.title, url: s.url }))));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed)
        };

    } catch (err) {
        console.error('Claude failed:', err.message);

        // Last-resort: topic-aware activities for both classes (no URLs = no broken links)
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ suggestions: [
                {
                    type: 'activity',
                    title: `Make an Awareness Poster About ${topic}`,
                    summary: `Create a poster that teaches others about ${topic} and what people can do to help.`,
                    instructions: `Use paper and colored pencils or markers. Write the issue at the top and draw a picture. Add 2–3 ideas for how people can help. You can hang it somewhere at home!`
                },
                {
                    type: 'activity',
                    title: `Write a Letter About ${topic}`,
                    summary: `Write a short letter telling someone why ${topic} matters to you.`,
                    instructions: `Start with "Dear ___," and explain what the problem is and why you care. Share one idea for how they could help. Sign your name at the end.`
                }
            ]})
        };
    }
};
