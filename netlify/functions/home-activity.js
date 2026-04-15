exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { topic, studentClass } = JSON.parse(event.body);
    const isCleaveland = studentClass === 'Ms. Cleaveland';
    const isGomez      = studentClass === 'Mr. Gomez';
    const gradeLevel   = isGomez ? '6th grade' : '4th–5th grade (reading below level, roughly 2nd–3rd grade)';

    // Helper: Serper search with timeout
    const serperSearch = async (q) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 4000);
        try {
            const res = await fetch('https://google.serper.dev/search', {
                method: 'POST',
                headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ q, num: 10 }),
                signal: controller.signal
            });
            const data = await res.json();
            return (data.organic || []).slice(0, 10).map(r => {
                let siteName = '';
                try { siteName = new URL(r.link).hostname.replace('www.', ''); } catch(e) {}
                return { title: r.title, url: r.link, snippet: r.snippet || '', siteName };
            });
        } finally {
            clearTimeout(timer);
        }
    };

    // ── 1. Serper search — kid-safe sites, focused on the social issue ───
    let searchResults = [];
    try {
        // Build an issue-focused query (not just the topic word)
        const issueQuery = `"${topic}" community problem kids site:wonderopolis.org OR site:dogonews.com OR site:kids.nationalgeographic.com OR site:scholastic.com/kids -video -lesson-plan -teacher -recipe -cooking`;
        searchResults = await serperSearch(issueQuery);
        console.log(`Primary Serper: ${searchResults.length} results for: ${topic}`);

        // Broaden slightly if too few — drop site restriction but keep issue framing
        if (searchResults.length < 2) {
            const broader = await serperSearch(
                `"${topic}" kids reading social issue community -video -recipe -cooking -lesson-plan`
            );
            searchResults = [...searchResults, ...broader].slice(0, 10);
            console.log(`Broader search: ${searchResults.length} results`);
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

    const activityFormat = `{ "type": "activity", "title": "...", "summary": "1 sentence", "steps": ["Step 1: ...", "Step 2: ...", "Step 3: ..."] }`;
    const articleFormat  = `{ "type": "article", "title": "...", "siteName": "...", "url": "...", "summary": "1 sentence" }`;

    let prompt;
    if (isCleaveland) {
        prompt = `You are helping a teacher assign at-home content for ${gradeLevel} students. The student cares about: "${topic}".

${hasResults ? `Search results from kid-friendly sites:\n${resultsText}` : 'No search results available.'}

Return exactly 2 suggestions:
1. ${hasResults ? `ARTICLE — pick the best TEXT article from the search results above that is written FOR KIDS (not teachers, not adults). It must be freely readable without login. Use the exact URL from the results. Skip any result that looks like a lesson plan, teacher guide, or adult resource.` : `ACTIVITY — connected to "${topic}"`}
2. ACTIVITY — a simple hands-on activity a student can do at home connected to "${topic}". Choose the most fitting type: make a poster, write a short speech, write a letter to someone who can help, draw a comic strip, create a fact card, or make a "Did You Know?" sign.

Strict rules:
- Article must be DIRECTLY about the social issue or community problem (e.g. if topic is "hunger", pick articles about food insecurity, food banks, or hunger relief — NOT cooking, recipes, or gardening).
- Article must be written for kids at ${gradeLevel} level, NOT for teachers or adults.
- Article must be freely readable — no login, no paywall, no subscription.
- Activity: simple language, basic supplies only (paper, pencil, markers). Exactly 3 steps, each starting with an action verb.
- NEVER invent URLs. NEVER suggest videos.

JSON only — no other text:
{
  "suggestions": [
    ${hasResults ? articleFormat : activityFormat},
    ${activityFormat}
  ]
}`;
    } else {
        prompt = `You are helping a teacher assign at-home reading for ${gradeLevel} students. The student cares about: "${topic}".

${hasResults ? `Search results from kid-friendly sites:\n${resultsText}` : 'No search results available.'}

${hasResults
    ? `Return the 2 best TEXT articles from the search results above that are:
- Written FOR KIDS at 6th grade level (not for teachers, not for adults, not academic papers)
- Freely readable without any login, account, or subscription
- Actual reading articles (not videos, lesson plans, or teacher guides)
- Directly relevant to "${topic}"
Use the exact URLs from the results only.`
    : `Suggest 2 real articles from wonderopolis.org or dogonews.com about "${topic}" or community action / helping others. Only suggest slugs you are highly confident exist.`
}

Rules:
- Articles must be DIRECTLY about the social issue or community problem (e.g. if topic is "hunger", pick articles about food insecurity, food banks, or hunger relief — NOT cooking, recipes, or gardening).
- 1-sentence summary per article, engaging tone for 6th graders.
- NEVER suggest videos. NEVER invent URLs.

JSON only — no other text:
{
  "suggestions": [
    ${articleFormat},
    ${articleFormat}
  ]
}`;
    }

    // ── 3. Call Claude ────────────────────────────────────────────────────
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
                    max_tokens: 900,
                    messages: [{ role: 'user', content: prompt }]
                }),
                signal: controller.signal
            });
            claudeData = await claudeRes.json();
        } finally {
            clearTimeout(timer);
        }

        const text = claudeData.content?.[0]?.text || '';
        console.log('Claude status:', claudeData.type, '| error:', claudeData.error?.message);
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error('No JSON in Claude response: ' + text.slice(0, 200));
        const parsed = JSON.parse(jsonMatch[0]);
        console.log('Suggestions:', JSON.stringify(parsed.suggestions?.map(s => ({ type: s.type, title: s.title }))));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed)
        };

    } catch (err) {
        console.error('Claude failed:', err.message);

        // Last-resort fallback — always activities (no broken URLs)
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ suggestions: [
                {
                    type: 'activity',
                    title: `Make an Awareness Poster About ${topic}`,
                    summary: `Create a colorful poster that teaches others about ${topic} and what people can do to help.`,
                    steps: [
                        `Write the issue ("${topic}") in big letters at the top of your paper.`,
                        `Draw a picture in the middle that shows the problem and how it affects people.`,
                        `Add 2–3 ideas at the bottom for how someone can help. Decorate with colors!`
                    ]
                },
                {
                    type: 'activity',
                    title: `Write a Letter About ${topic}`,
                    summary: `Write a short letter to someone — a family member, teacher, or local leader — telling them why ${topic} matters.`,
                    steps: [
                        `Start with "Dear ___," and write 1–2 sentences explaining what ${topic} is.`,
                        `Write 1–2 sentences about why this issue matters to you personally.`,
                        `End with one idea for how they could help, then sign your name.`
                    ]
                }
            ]})
        };
    }
};
