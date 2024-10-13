import { DurableObject } from 'cloudflare:workers';

// Worker
export default {
	async fetch(request, env, ctx): Promise<Response> {
		if (request.url.endsWith('/websocket')) {
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				return new Response('Durable Object expected Upgrade: websocket', { status: 426 });
			}

			const accessToken = request.headers.get('Authorization');
			const id = env.CONVERSATIONS.idFromName(`conversation-${accessToken}`);
			const conversationDO = env.CONVERSATIONS.get(id);
			return conversationDO.fetch(request);
		}

		return new Response(null, {
			status: 400,
			statusText: 'Bad Request',
			headers: {
				'Content-Type': 'text/plain',
			},
		});
	},
} satisfies ExportedHandler<Env>;

// Durable Object
export class ConversationDO extends DurableObject {
	env: Env;
	messages: { role: string; content: string | ArrayBuffer }[];
	openAISocket: WebSocket | null;
	workerSocket: WebSocket | null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		this.openAISocket = null;
		this.workerSocket = null;
		this.messages = [];
	}

	async fetch(request: Request) {
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		await this.handleSession(server);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async handleSession(workerWs: WebSocket) {
		workerWs.accept();
		this.workerSocket = workerWs;

		this.openAISocket = await this.connectToOpenAI();

		workerWs.addEventListener('message', async (event) => {
			/**
			 * Send the message to OpenAI
			 * Store message in DurableObject state
			 */

			workerWs.send(`Sending "` + event.data + `" to OpenAI`);
			if (this.openAISocket && this.openAISocket.readyState === WebSocket.OPEN) {
				this.openAISocket.send(event.data);
				this.storeMessage('user', event.data);
			}
		});

		workerWs.addEventListener('close', async (cls: CloseEvent) => {
			/**
			 * Close the openAI socket
			 * Store the conversation to the database (Arcane)
			 * Close the workerWs socket
			 */

			if (this.openAISocket) {
				this.openAISocket.close();
			}
			// await this.dumpConversationToArcane()

			if (this.workerSocket) {
				console.log('[ConversationDO] closing Worker WebSocket');
				this.workerSocket = null;
				workerWs.close(cls.code, `Worker Websocket is closing...`);
			}
		});
	}

	async connectToOpenAI() {
		const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';
		const openAISocket = new WebSocket(url, ['realtime', `openai-insecure-api-key.${this.env.OPENAI_API_KEY}`, 'openai-beta.realtime-v1']);

		openAISocket.addEventListener('open', () => {
			console.log('Connected to OpenAI server.');
			openAISocket.send(
				JSON.stringify({
					type: 'response.create',
					response: {
						modalities: ['text'],
						instructions: 'Hello!',
					},
				})
			);
		});

		openAISocket.addEventListener('message', async (event) => {
			if (this.workerSocket && this.workerSocket.readyState === WebSocket.OPEN) {
				this.workerSocket.send(`Received "` + event.data + `" from OpenAI`);
				this.storeMessage('assistant', event.data);
			}
		});

		return openAISocket;
	}

	storeMessage(role: string, content: string | ArrayBuffer) {
		this.messages.push({ role, content });
		// await this.ctx.storage.put('messages', this.messages);
	}
}
