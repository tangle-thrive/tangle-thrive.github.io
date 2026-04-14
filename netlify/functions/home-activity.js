exports.handler = async (event) => {
    if (event.httpMethod !== 'POST') {
        return { statusCode: 405, body: 'Method Not Allowed' };
    }

    try {
        const { topic, studentClass } = JSON.parse(event.body);
        const isGomez      = studentClass === 'Mr. Gomez';
        const isCleaveland = studentClass === 'Ms. Cleaveland';
        const gradeDesc    = isGomez
            ? '6th grade students'
            : '4th and 5th grade students who read below grade level (roughly 2nd–3rd grade reading level)';

        // ── 1. Search Serper for relevant articles ──────────────────────
        const searchQuery = `${topic} for kids site:pbslearningmedia.org OR site:wonderopolis.org OR site:dogonews.com OR site:kids.nationalgeographic.com`;

        const serperRes = await fetch('https://google.serper.dev/search', {
            method: 'POST',
            headers: {
                'X-API-KEY': process.env.SERPER_API_KEY,
                'Content-Type': 'application/json'
            },
            body: JSON.stringify({ q: searchQuery, num: 8 })
        });

        const serperData = await serperRes.json();
        const results = (serperData.organic || []).slice(0, 8).map(r => {
            let siteName = '';
            try { siteName = new URL(r.link).hostname.replace('www.', ''); } catch(e) {}
            return { title: r.title, url: r.link, snippet: r.snippet || '', siteName };
        });

        // ── 2. Build Claude prompt ───────────────────────────────────────
        const resultsText = results.length
            ? results.map((r, i) =>
                `${i + 1}. ${r.title}\n   URL: ${r.url}\n   Site: ${r.siteName}\n   Snippet: ${r.snippet}`
              ).join('\n\n')
            : '(No search results found — please generate fallback suggestions.)';

        let prompt;

        if (isCleaveland) {
            prompt = `You are helping a teacher find engaging at-home content for ${gradeDesc}. The student cares about this issue: "${topic}".

Search results from school-appropriate websites:
${resultsText}

Return exactly 2 suggestions as JSON:
1. An ARTICLE from the search results (pick the simplest, most relevant one for below-grade-level readers). If no good results exist, suggest one from wonderopolis.org or dogonews.com about helping the community or the general issue.
2. An ACTIVITY the student can do at home that connects to their issue (make a poster, write a short speech, write a letter, draw a comic strip, etc. — simple, no special materials). Claude should choose the most appropriate activity type for the specific issue.

Rules:
- Article summary: 1 sentence, simple words, exciting tone, appropriate for 4th/5th graders reading below level.
- Activity summary: 1 sentence describing what they'll make/do.
- Activity instructions: 2–3 clear sentences a child can follow on their own.
- Never recommend anything that requires an account or login.

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
            // Gomez — 2 articles
            prompt = `You are helping a teacher find engaging at-home articles for ${gradeDesc}. The student cares about this issue: "${topic}".

Search results from school-appropriate websites:
${resultsText}

Return exactly 2 article suggestions. Pick the most appropriate ones for 6th graders. If fewer than 2 good results exist, suggest ones from pbslearningmedia.org, wonderopolis.org, or dogonews.com about the general issue or how young people can make a difference in their community.

Rules:
- Summary: 1 sentence, engaging tone, explains what the student will learn.
- Never recommend anything that requires an account or login.

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
      "type": "article",
      "title": "...",
      "siteName": "...",
      "url": "...",
      "summary": "..."
    }
  ]
}`;
        }

        // ── 3. Call Claude ───────────────────────────────────────────────
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

        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(parsed)
        };

    } catch (err) {
        console.error('home-activity error:', err);
        // Fallback suggestions
        return {
            statusCode: 200,
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                suggestions: [
                    {
                        type: 'article',
                        title: 'How Kids Are Changing the World',
                        siteName: 'wonderopolis.org',
                        url: 'https://www.wonderopolis.org/wonder/how-can-one-person-change-the-world',
                        summary: 'Find out how young people just like you are taking action and making a real difference in their communities.'
                    },
                    {
                        type: 'article',
                        title: 'Kids Making a Difference',
                        siteName: 'pbslearningmedia.org',
                        url: 'https://www.pbslearningmedia.org/collection/kids-making-a-difference/',
                        summary: 'Explore stories of kids who saw a problem in the world and found creative ways to help.'
                    }
                ]
            })
        };
    }
};
