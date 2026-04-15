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

    // ── Step 1: Ask Claude for article titles + sites (no URLs) ──────────
    const activityFormat = `{ "type": "activity", "title": "...", "summary": "1 sentence", "steps": ["Step 1: ...", "Step 2: ...", "Step 3: ..."] }`;
    const articleDraftFormat = `{ "type": "article", "title": "exact article title", "site": "wonderopolis.org", "summary": "1 sentence" }`;

    let prompt;
    if (isCleaveland) {
        prompt = `You are helping a teacher assign at-home content for ${gradeLevel} students. The student cares about the issue: "${normalizedTopic}".

Return exactly 2 suggestions:
1. ARTICLE — suggest a real article title and the site it is on. Use only: wonderopolis.org, dogonews.com, timeforkids.com, or kids.nationalgeographic.com. The article must be DIRECTLY about the social issue or community problem (e.g. if topic is "hunger", suggest an article about food insecurity, food banks, or hunger relief — NOT cooking, recipes, or gardening). The article must be written for kids, not teachers.
2. ACTIVITY — a simple hands-on activity a student can do at home connected to "${normalizedTopic}". Good types: make an awareness poster, write a short speech, write a letter to someone who can help, draw a comic strip, create a fact card, make a "Did You Know?" sign.

Rules:
- For the article, provide the EXACT article title as it appears on the site. Only suggest articles you have strong confidence exist on that site.
- Activity: basic supplies only (paper, pencil, markers). Exactly 3 steps, each starting with an action verb.

JSON only — no other text:
{
  "suggestions": [
    ${articleDraftFormat},
    ${activityFormat}
  ]
}`;
    } else {
        prompt = `You are helping a teacher assign at-home reading for ${gradeLevel} students. The student cares about the issue: "${normalizedTopic}".

Return exactly 2 ARTICLE suggestions from: wonderopolis.org, dogonews.com, timeforkids.com, or kids.nationalgeographic.com. The articles must be:
- DIRECTLY about the social issue or community problem (e.g. if topic is "hunger", suggest articles about food insecurity, food banks, or hunger relief — NOT cooking, recipes, or gardening)
- Written FOR KIDS at 6th grade level (not for teachers, not academic)
- Real articles you are confident exist on that site

Rules:
- Provide the EXACT article title as it appears on the site.
- 1-sentence summary per article, engaging tone for 6th graders.

JSON only — no other text:
{
  "suggestions": [
    ${articleDraftFormat},
    ${articleDraftFormat}
  ]
}`;
    }

    // ── Helper: Serper search with timeout ───────────────────────────────
    const serperSearch = async (q) => {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 3500);
        try {
            const res = await fetch('https://google.serper.dev/search', {
                method: 'POST',
                headers: { 'X-API-KEY': process.env.SERPER_API_KEY, 'Content-Type': 'application/json' },
                body: JSON.stringify({ q, num: 5 }),
                signal: controller.signal
            });
            const data = await res.json();
            return (data.organic || [])[0] || null;
        } catch (e) {
            console.error('Serper error:', e.message);
            return null;
        } finally {
            clearTimeout(timer);
        }
    };

    // ── Step 2: Call Claude ───────────────────────────────────────────────
    let suggestions = [];
    try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 6000);
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
        suggestions = JSON.parse(jsonMatch[0]).suggestions || [];
        console.log('Claude drafts:', JSON.stringify(suggestions.map(s => ({ type: s.type, title: s.title, site: s.site }))));
    } catch (err) {
        console.error('Claude failed:', err.message);
    }

    // ── Step 3: Validate article URLs via Serper in parallel ─────────────
    const validated = await Promise.all(suggestions.map(async (s) => {
        if (s.type !== 'article') return s; // activities don't need validation

        // Search for the exact title on the suggested site
        const query = `"${s.title}" site:${s.site}`;
        const isExcluded = (url) => excludeUrl && url && url === excludeUrl;

        const result = await serperSearch(query);
        if (result && result.link && !isExcluded(result.link)) {
            let siteName = s.site;
            try { siteName = new URL(result.link).hostname.replace('www.', ''); } catch (e) {}
            console.log('Validated:', result.link);
            return { type: 'article', title: result.title || s.title, siteName, url: result.link, summary: s.summary };
        }

        // Broader fallback search if exact title not found
        const broader = await serperSearch(`${normalizedTopic} social issue kids site:${s.site}`);
        if (broader && broader.link && !isExcluded(broader.link)) {
            let siteName = s.site;
            try { siteName = new URL(broader.link).hostname.replace('www.', ''); } catch (e) {}
            console.log('Broader validated:', broader.link);
            return { type: 'article', title: broader.title || s.title, siteName, url: broader.link, summary: s.summary };
        }

        // For Gomez (articles only), try any kid site before giving up
        if (isGomez) {
            const anyArticle = await serperSearch(`"${normalizedTopic}" social issue kids article site:wonderopolis.org OR site:dogonews.com OR site:timeforkids.com`);
            if (anyArticle && anyArticle.link && !isExcluded(anyArticle.link)) {
                let siteName = '';
                try { siteName = new URL(anyArticle.link).hostname.replace('www.', ''); } catch (e) {}
                console.log('Gomez fallback validated:', anyArticle.link);
                return { type: 'article', title: anyArticle.title || s.title, siteName, url: anyArticle.link, summary: s.summary };
            }
        }

        // Could not validate — replace with an activity (Cleaveland only)
        console.log('Could not validate URL for:', s.title, '— replacing with activity');
        return {
            type: 'activity',
            title: `Make an Awareness Poster About ${topic}`,
            summary: `Create a colorful poster that teaches others about ${topic} and what people can do to help.`,
            steps: [
                `Write "${topic}" in big letters at the top of your paper.`,
                `Draw a picture in the middle that shows the problem and how it affects people.`,
                `Add 2–3 ideas at the bottom for how someone can help, then decorate with colors.`
            ]
        };
    }));

    // ── Return results ────────────────────────────────────────────────────
    if (validated.length > 0) {
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ suggestions: validated })
        };
    }

    // Last-resort fallback
    return {
        statusCode: 200,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ suggestions: [
            {
                type: 'activity',
                title: `Make an Awareness Poster About ${topic}`,
                summary: `Create a colorful poster that teaches others about ${topic} and what people can do to help.`,
                steps: [
                    `Write "${topic}" in big letters at the top of your paper.`,
                    `Draw a picture in the middle that shows the problem and how it affects people.`,
                    `Add 2–3 ideas at the bottom for how someone can help, then decorate with colors.`
                ]
            },
            {
                type: 'activity',
                title: `Write a Letter About ${topic}`,
                summary: `Write a short letter telling someone why ${topic} matters and how they can help.`,
                steps: [
                    `Start with "Dear ___," and write 1–2 sentences explaining what ${topic} is.`,
                    `Write 1–2 sentences about why this issue matters to you personally.`,
                    `End with one idea for how they could help, then sign your name.`
                ]
            }
        ]})
    };
};
