// Netlify Function: GET /api/config — tells the page how many questions and whether a class code is needed.
export default async () =>
  new Response(JSON.stringify({
    maxQuestions: parseInt(process.env.MAX_QUESTIONS || '3', 10),
    hasKey: Boolean(process.env.OPENAI_API_KEY),
    needCode: Boolean(process.env.CLASS_CODE),
  }), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });

export const config = { path: '/api/config' };
