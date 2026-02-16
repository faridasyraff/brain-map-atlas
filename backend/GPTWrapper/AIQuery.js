import OpenAI from "openai";
import { REGION_LIST } from "../RegionList/regionList.js";

const SYSTEM_PROMPT = `
You map neuroscience questions to Allen Brain Atlas regions.

Rules:
- Use ONLY the provided region list
- Do NOT invent regions
- Return JSON ONLY
- If the question is broad, return multiple regions
- If unsure, return an empty list

You are not a medical expert.
`;

export async function mapQuestionToRegions(question = "what brain area is associated with pain?") {

    const client = new OpenAI();


    const response = await client.responses.create({
        model: "gpt-4.1-mini",
        input: [
            {
                role: "system",
                content: SYSTEM_PROMPT
            },
            {
                role: "user",
                content: `
Question:
"${question}"

Available regions:
${REGION_LIST.map(r => `- ${r.name} (${r.acronym}) [${r.id}]`).join("\n")}

Return JSON in this format:
{
  "matched_regions": [
    { "region_id": number, "confidence": number, "reason": string }
  ],
  "uncertainty_note": string
}
`
            }
        ]
    });

    return JSON.parse(response.output_text);
}
