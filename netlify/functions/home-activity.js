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

    // ── 1. Try Serper (non-fatal if it fails) ───────────────────────────
    let searchResults = [];
    try {
        const serperRes = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: {
                'X-API-KEY': process.env.SERPER_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({
                q: `${topic} for kids site:pbslearningmedia.org OR site:wonderopolis.org OR site:dogonews.com OR site:kids.nationalgeographic.com`,
                num: 8
            })
        });
        const serperData = await serperRes.json();
        searchResults = (serperData.organic || []).slice(0, 8).map(r => {
            let siteName = '';
            try { siteName = new URL(r.link).hostname.replace('www.', ''); } catch(e) {}
            return { title: r.title, url: r.link, snippet: r.snippet || '', siteName };
        });
        console.log(`Serper returned ${searchResults.length} results for: ${topic}`);
    } catch (e) {
        console.error('Serper search failed (non-fatal):', e.message);
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
        prompt = `You are helping a teacher find engaging at-home content for ${gradeDesc}. The student cares about this issue: "${topic}".

${hasResults ? `Search results from school-appropriate websites:\n${resultsText}\n\nReturn exactly 2 suggestions:
1. An ARTICLE — pick the best one from the search results above (most relevant, simplest language). Only use a URL from the search results above — do NOT invent URLs.
2. An ACTIVITY — something the student can do at home connected to their specific issue.` : `No search results available. Return exactly 2 suggestions:
1. An ACTIVITY — something the student can do at home connected to their specific issue.
2. Another ACTIVITY — a different type connected to their specific issue.`}

Activity types to choose from (pick what fits the issue best): make a poster, write a short speech, write a letter to someone who can help, draw a comic strip, create a fact card, make a "Did You Know?" sign.

Rules:
- Keep language very simple — 2nd/3rd grade reading level.
- Article summary: 1 short sentence, exciting tone.
- Activity summary: 1 sentence saying what they'll make/do.
- Activity instructions: 2–3 very clear sentences a child can follow alone with basic supplies.
- NEVER invent article URLs — only use URLs from search results provided.

Respond ONLY with valid JSON:
{
  "suggestions": [
    {
      "type": "article",
      "title": "...",
      "siteName": "...",
      "url": "...",
      "summary": "..."
    },
    {
      "type": "activity",
      "title": "...",
      "summary": "...",
      "instructions": "..."
    }
  ]
}`;
    } else {
        // Gomez — 2 articles (or activities if no search results)
        prompt = `You are helping a teacher find engaging at-home content for ${gradeDesc}. The student cares about this issue: "${topic}".

${hasResults ? `Search results from school-appropriate websites:\n${resultsText}\n\nReturn exactly 2 article suggestions from the search results above. Only use URLs from the search results — do NOT invent URLs.` : `No search results available. Return 2 ACTIVITY suggestions the student can do at home connected to their specific issue ("${topic}").`}

Rules:
- Summary: 1 sentence, engaging tone, explains what the student will learn or do.
- For articles: only use URLs from search results above.
- For activities (if no search results): give clear 2–3 sentence instructions, no special materials needed.
- NEVER invent article URLs.

Respond ONLY with valid JSON:
{
  "suggestions": [
    {
      "type": "article or activity",
      "title": "...",
      "siteName": "...(if article)",
      "url": "...(if article)",
      "summary": "...",
      "instructions": "...(if activity)"
    },
    {
      "type": "article or activity",
      "title": "...",
      "siteName": "...(if article)",
      "url": "...(if article)",
      "summary": "...",
      "instructions": "...(if activity)"
    }
  ]
}`;
    }

    // ── 3. Call Claude ───────────────────────────────────────────────────
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

        // ── 4. Verify article URLs (HEAD request, drop 404s) ────────────
        const verified = await Promise.all((parsed.suggestions || []).map(async s => {
            if (s.type !== 'article' || !s.url) return s;
            try {
                const check = await fetch(s.url, { method: 'HEAD', redirect: 'follow' });
                if (!check.ok) {
                    console.warn(`URL check failed (${check.status}): ${s.url}`);
                    // Convert broken article to a search link on the same site
                    const domain = s.siteName || 'wonderopolis.org';
                    const query = encodeURIComponent(topic);
                    s.url = `https://${domain}/search/?q=${query}`;
                    s.title = `Search results: ${topic}`;
                }
            } catch(e) {
                console.warn(`URL check error for ${s.url}:`, e.message);
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

        // Last-resort fallback: topic-aware activities (no URLs)
        const activityFallback = [
            {
                type: 'activity',
                title: `Make a "${topic}" Awareness Poster`,
                summary: `Create a poster that teaches others about ${topic} and what people can do to help.`,
                instructions: `Use paper and colored pencils or markers. Write the issue at the top, draw a picture that shows the problem, and add 2–3 facts or ideas for how people can help. You can hang it somewhere at home!`
            },
            {
                type: 'activity',
                title: `Write a Letter About ${topic}`,
                summary: `Write a letter to someone — a family member, teacher, or local leader — telling them why ${topic} matters to you.`,
                instructions: `Start with "Dear ___," and explain what the problem is and why you care. Then share one idea for how they could help. Sign your name at the end.`
            }
        ];

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ suggestions: activityFallback })
        };
    }
};
