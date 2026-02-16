import { mapQuestionToRegions } from "./AIQuery.js";

async function runTest() {
    const questions = [
        "Which brain regions are associated with pain?",
        "Which brain regions are associated with autism?",
        "What brain region are affected by stroke?"
    ];
    for (const question of questions) {
        const result = await mapQuestionToRegions(question);
        console.log(`Question: ${question}`);
        console.log("GPT output:", JSON.stringify(result, null, 2));
    }
}

runTest();
