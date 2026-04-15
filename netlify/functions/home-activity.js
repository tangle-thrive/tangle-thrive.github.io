exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    const { topic, studentClass } = JSON.parse(event.body);
    const isCleaveland = studentClass === 'Ms. Cleaveland';
    const isGomez      = studentClass === 'Mr. Gomez';
    const gradeLevel   = isGomez ? '6th grade' : '4th–5th grade (reading level closer to 2nd–3rd grade)';

    const activityFormat = `{ "type": "activity", "title": "...", "summary": "1 sentence", "steps": ["Step 1: ...", "Step 2: ...", "Step 3: ..."] }`;
    const articleFormat  = `{ "type": "article", "title": "...", "siteName": "...", "url": "...", "summary": "1 sentence" }`;

    let prompt;

    if (isCleaveland) {
        prompt = `You are helping a teacher assign at-home content for ${gradeLevel} students. The student cares about the issue: "${topic}".

Return exactly 2 suggestions:
1. ARTICLE — a real article you are HIGHLY CONFIDENT exists and is still live at its URL. Use only these trusted kid-friendly sites: wonderopolis.org, dogonews.com, timeforkids.com, kids.nationalgeographic.com. The article must be DIRECTLY about the social issue or community problem (e.g. if topic is "hunger", pick an article about food insecurity, food banks, or hunger relief — NOT about cooking, recipes, or gardening). It must be written for kids, freely readable without any login.
2. ACTIVITY — a simple hands-on activity a student can do at home connected to "${topic}". Good types: make an awareness poster, write a short speech, write a letter to someone who can help, draw a comic strip, create a fact card, make a "Did You Know?" sign.

Rules:
- ONLY suggest article URLs you are highly confident exist and are currently live. If you are not sure, choose a different article you ARE sure about.
- Article must be at ${gradeLevel} reading level. NOT for teachers or adults.
- Activity: basic supplies only (paper, pencil, markers). Exactly 3 steps, each starting with an action verb.
- NEVER invent or guess URLs. NEVER suggest videos.

JSON only — no other text:
{
  "suggestions": [
    ${articleFormat},
    ${activityFormat}
  ]
}`;
    } else {
        prompt = `You are helping a teacher assign at-home reading for ${gradeLevel} students. The student cares about the issue: "${topic}".

Return exactly 2 ARTICLE suggestions. Use only these trusted kid-friendly sites: wonderopolis.org, dogonews.com, timeforkids.com, kids.nationalgeographic.com. The articles must be:
- DIRECTLY about the social issue or community problem (e.g. if topic is "hunger", pick articles about food insecurity, food banks, or hunger relief — NOT cooking, recipes, or gardening)
- Written FOR KIDS at 6th grade level (not for teachers, not academic)
- Freely readable without any login or subscription
- Real articles you are HIGHLY CONFIDENT exist at that exact URL

Rules:
- ONLY suggest URLs you are highly confident are currently live. If you are not sure about a specific URL, choose a different article on the same site that you ARE sure about.
- 1-sentence summary per article, engaging tone for 6th graders.
- NEVER suggest videos. NEVER invent or guess URLs.

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
        console.log('Suggestions:', JSON.stringify(parsed.suggestions?.map(s => ({ type: s.type, title: s.title, url: s.url }))));

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed)
        };

    } catch (err) {
        console.error('Claude failed:', err.message);

        // Last-resort fallback — activities only (no risky URLs)
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
