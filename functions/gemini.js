import { GoogleGenAI, Type } from '@google/genai';

class Gemini {
  constructor(transcript, books) {
    this.apiKeys = [
      'AIzaSyBN1W4UL5Lqp6EJlJSqvbEjSkw0IGsBCYA',
      'AIzaSyD7hh8KJrjp4TOeOpVudNIKBOT2Id3dkKY',
      'AIzaSyACYfJy7J_QwNtn255nkaZVjPEYnfco-gI',
      'AIzaSyB4sC__WwOCs2XuEJmLbXT84IX-ZMKXj2Y',
      'AIzaSyCWcdp_gaayeJ1Nvx62TrhhkSOYaP2qrLc',
      'AIzaSyCLiqlJRq1NmsDKxTmsbRiDYQ63z4RBOa0'
    ];

    if (this.apiKeys.length === 0) {
      throw new Error('No API keys provided');
    }

    this.transcript = transcript;
    this.books = books;
    this.model = 'gemini-2.5-pro';

    const fence = '```';
    this.input = `
You are a sales-coach AI. You will be given a transcript of a sales conversation. Analyze it:

{
  "Into": string,
  "Review": {
    "steps": [
      "into step analysis",
      "investigation step analysis",
      "demonstration step analysis",
      "closing step analysis"
    ],
    "skills": [
      "listening: …",
      "asking questions: …",
      "objection handling: …",
      "clear speech: …"
    ],
    "opportunities missed": [
      "questions not asked: …",
      "objections not well-addressed: …",
      "missed buying signals: …"
    ]
  },
  "advices": {
    "new sales habit": string,
    "remove bad sales habit": string
    at the end here mention the used books that you used to analyze the transcript
  }
}

Here is the transcript to analyze (delimited by triple-backticks):\n${fence}\n${transcript}\n${fence}\n

Respond **only** with the fully populated JSON.
You must refrence the books information and the transcript part that you are analyzing in the analysis text, and give an alternative way of doing stuff, so whenever you critizing something, say which part of the conversation you are mentioning and which part of the book you decided to use to make your option, and if it is critism then you need to say what is a better way to do it.
Your analysis must be based on these books and their content, be sure to use them:
Here is the books to use (delimited by triple-backticks):\n${fence}\n${books}\n${fence}\n
VERY VERY IMPORTANT that you respond in english
`;
  }

  async getResponse() {
    for (let i = 0; i < this.apiKeys.length; i++) {
      const currentKey = this.apiKeys[i];
      try {
        const ai = new GoogleGenAI({ apiKey: currentKey });

        const response = await ai.models.generateContent({
          model: this.model,
          contents: this.input,
          config: {
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                Into: { type: Type.STRING },
                Review: {
                  type: Type.OBJECT,
                  properties: {
                    steps: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING }
                    },
                    skills: {
                      type: Type.ARRAY,
                      items: { type: Type.STRING }
                    },
                    'opportunities missed': {
                      type: Type.ARRAY,
                      items: { type: Type.STRING }
                    }
                  },
                  required: ['steps', 'skills', 'opportunities missed']
                },
                advices: {
                  type: Type.OBJECT,
                  properties: {
                    'new sales habit': { type: Type.STRING },
                    'remove bad sales habit': { type: Type.STRING }
                  },
                  required: ['new sales habit', 'remove bad sales habit']
                }
              },
              required: ['Into', 'Review', 'advices']
            }
          }
        });

        return { response: response.text, error: null };
      } catch (error) {
        console.warn(`API key ${i + 1} failed: ${error.message}`);
        if (i === this.apiKeys.length - 1) {
          return { response: null, error: `Gemini API error: ${error.message}` };
        }
      }
    }
  }
}

export default Gemini;
