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

    // ── 1. Try Serper — first with site filter, then broader if < 2 results ──
    let searchResults = [];
    try {
        const runSearch = async (q) => {
            const res = await fetch('https://google.serper.dev/search', {
                method: 'POST',
                headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ q, num: 8 })
            });
            const data = await res.json();
            return (data.organic || []).slice(0, 8).map(r => {
                let siteName = '';
                try { siteName = new URL(r.link).hostname.replace('www.', ''); } catch(e) {}
                return { title: r.title, url: r.link, snippet: r.snippet || '', siteName };
            });
        };

        // First: site-scoped search
        searchResults = await runSearch(
            `${topic} for kids site:pbslearningmedia.org OR site:wonderopolis.org OR site:dogonews.com OR site:kids.nationalgeographic.com`
        );
        console.log(`Site-scoped Serper: ${searchResults.length} results`);

        // Fallback: broader search if too few results
        if (searchResults.length < 2) {
            const broader = await runSearch(`${topic} for kids reading article school`);
            searchResults = [...searchResults, ...broader].slice(0, 8);
            console.log(`Broader Serper: ${searchResults.length} total results`);
        }
    } catch (e) {
        console.error('Serper search failed (non-fatal):', e.message);
    }

    // ── 2. Build Claude prompt ────────────────────────────────────────────
    const hasResults = searchResults.length > 0;
    const resultsText = hasResults
        ? searchResults.map((r, i) =>
            `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Site: ${r.siteName}\n   Snippet: ${r.snippet}`
          ).join('\n\n')
        : null;

    let prompt;
    if (isCleaveland) {
        prompt = `You are helping a teacher find engaging at-home content for ${gradeDesc}. The student cares about this issue: "${topic}".

${hasResults
    ? `Search results from school-appropriate websites:\n${resultsText}\n\nReturn exactly 2 suggestions:\n1. ARTICLE — the best one from search results above (most relevant, simplest language). Only use URLs from the search results — never invent URLs.\n2. ACTIVITY — something the student can do at home connected to "${topic}".`
    : `No search results found. Return 2 suggestions:\n1. ACTIVITY — connected to "${topic}".\n2. A different ACTIVITY — connected to "${topic}".`
}

Activity types (pick what fits best): make a poster, write a short speech, write a letter to someone who can help, draw a comic strip, create a fact card, make a "Did You Know?" sign.

Rules:
- Simple language — 2nd/3rd grade reading level.
- Summary: 1 short exciting sentence.
- Activity instructions: 2–3 clear sentences, basic supplies only.
- NEVER invent article URLs.

Respond ONLY with valid JSON:
{
  "suggestions": [
    { "type": "article", "title": "...", "siteName": "...", "url": "...", "summary": "..." },
    { "type": "activity", "title": "...", "summary": "...", "instructions": "..." }
  ]
}`;
    } else {
        // Gomez — always 2 articles
        prompt = `You are helping a teacher find 2 engaging at-home articles for ${gradeDesc}. The student cares about: "${topic}".

${hasResults
    ? `Search results from school-appropriate websites:\n${resultsText}\n\nPick the 2 best articles from the results above. Only use URLs from the search results — never invent URLs.`
    : `No search results found. Suggest 2 Wonderopolis wonders (wonderopolis.org) that you are confident exist and relate to "${topic}" or to community action, the environment, or helping others. Use the URL format: https://www.wonderopolis.org/wonder/[slug]. Only suggest wonders you are highly confident are real.`
}

Rules:
- Summary: 1 sentence, engaging, explains what the student will learn.
- Only real URLs — never guess.

Respond ONLY with valid JSON:
{
  "suggestions": [
    { "type": "article", "title": "...", "siteName": "...", "url": "...", "summary": "..." },
    { "type": "article", "title": "...", "siteName": "...", "url": "...", "summary": "..." }
  ]
}`;
    }

    // ── 3. Call Claude ─────────────────────────────────────────────────
    try {
        const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
            method: 'POST',
            headers: {
                'x-api-key': process.env.CLAUDE_API_KEY,
                'anthropic-version': '2023-06-01',
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                model: 'claude-3-5-haiku-20241022',
                max_tokens: 1000,
                messages: [{ role: 'user', content: prompt }]
            })
        });
        const claudeData = await claudeRes.json();
        const text = claudeData.content?.[0]?.text || '';
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in Claude response');
        const parsed = JSON.parse(jsonMatch[0]);

        // ── 4. Verify article URLs ──────────────────────────────────────
        const verified = await Promise.all((parsed.suggestions || []).map(async s => {
            if (s.type !== 'article' || !s.url) return s;
            try {
                const check = await fetch(s.url, { method: 'HEAD', redirect: 'follow' });
                if (!check.ok) {
                    console.warn(`URL ${check.status}: ${s.url} — replacing with search`);
                    const q = encodeURIComponent(topic);
                    s.url = `https://www.wonderopolis.org/search/?q=${q}`;
                    s.siteName = 'wonderopolis.org';
                    s.title = `Search: ${topic} on Wonderopolis`;
                }
            } catch(e) {
                console.warn(`URL check error: ${e.message}`);
            }
            return s;
        }));
        parsed.suggestions = verified;

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed)
        };

    } catch (err) {
        console.error('Claude call failed:', err.message);

        // Last-resort fallback — topic-aware, class-aware
        if (isGomez) {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ suggestions: [
                    {
                        type: 'article',
                        title: `Search: ${topic}`,
                        siteName: 'wonderopolis.org',
                        url: `https://www.wonderopolis.org/search/?q=${encodeURIComponent(topic)}`,
                        summary: `Find articles and wonders about ${topic} on Wonderopolis.`
                    },
                    {
                        type: 'article',
                        title: `Search: ${topic}`,
                        siteName: 'dogonews.com',
                        url: `https://www.dogonews.com/search?q=${encodeURIComponent(topic)}`,
                        summary: `Read kid-friendly news articles about ${topic} on Dogo News.`
                    }
                ]})
            };
        } else {
            return {
                statusCode: 200,
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ suggestions: [
                    {
                        type: 'activity',
                        title: `Make a "${topic}" Awareness Poster`,
                        summary: `Create a poster that teaches others about ${topic} and what people can do to help.`,
                        instructions: `Use paper and colored pencils or markers. Write the issue at the top, draw a picture that shows the problem, and add 2–3 ideas for how people can help. You can hang it somewhere at home!`
                    },
                    {
                        type: 'activity',
                        title: `Write a Letter About ${topic}`,
                        summary: `Write a letter to someone — a family member, teacher, or local leader — telling them why ${topic} matters to you.`,
                        instructions: `Start with "Dear ___," and explain what the problem is and why you care. Then share one idea for how they could help. Sign your name at the end.`
                    }
                ]})
            };
        }
    }
};
