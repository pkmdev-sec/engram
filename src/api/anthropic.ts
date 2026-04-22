import Anthropic from "@anthropic-ai/sdk";

let client: Anthropic | null = null;

function getClient(): Anthropic {
	if (!client) {
		if (!process.env.ANTHROPIC_API_KEY) {
			throw new Error("ANTHROPIC_API_KEY is not set. Required for distillation and compaction.");
		}
		client = new Anthropic({
			timeout: 120_000, // 2 minutes — hooks have limited lifetime
		});
	}
	return client;
}

export async function callAnthropic(
	model: string,
	system: string,
	userMessage: string,
	maxTokens = 4096,
): Promise<string> {
	const anthropic = getClient();
	const response = await anthropic.messages.create({
		model,
		max_tokens: maxTokens,
		system,
		messages: [{ role: "user", content: userMessage }],
	});
	// Only text blocks carry a `.text` property — filter before accessing.
	return response.content
		.filter((block): block is Anthropic.TextBlock => block.type === "text")
		.map((block) => block.text)
		.join("");
}
