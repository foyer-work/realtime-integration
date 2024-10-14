import { DurableObject } from 'cloudflare:workers';

// Worker
export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/websocket') {
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				return new Response('Durable Object expected Upgrade: websocket', { status: 426 });
			}

			const accessToken = request.headers.get('Authorization');
			console.log({ accessToken });
			const id = env.CONVERSATIONS.idFromName(`conversation-${accessToken}`);
			const conversationDO = env.CONVERSATIONS.get(id);
			return conversationDO.fetch(request.clone());
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
	messageQueue: (string | ArrayBuffer)[];
	openAIClient: WebSocket | null;
	workerSocket: WebSocket | null;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		this.openAIClient = null;
		this.workerSocket = null;
		this.messageQueue = [];
	}

	fetch() {
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		this.handleSession(server);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	handleSession(workerWs: WebSocket) {
		workerWs.accept();
		this.workerSocket = workerWs;

		this.openAIClient = this.connectToOpenAI();

		workerWs.addEventListener('message', (event) => {
			/**
			 * Send the message to OpenAI
			 * Store message in DurableObject state
			 */

			if (!this.openAIClient || this.openAIClient.readyState !== WebSocket.OPEN) {
				this.messageQueue.push(event.data);
			} else {
				this.openAIClient.send(event.data);
			}
		});

		workerWs.addEventListener('close', () => {
			/**
			 * Close the openAI socket
			 * Store the conversation to the database (Arcane)
			 * Close the workerWs socket
			 */

			// await this.dumpConversationToArcane()
			if (this.openAIClient && this.openAIClient.readyState === WebSocket.OPEN) {
				console.log('[ConversationDO] Worker/Client closed the connection.');
				this.openAIClient.close();
			}
		});
	}

	connectToOpenAI() {
		const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';
		const openAIClient = new WebSocket(url, ['realtime', `openai-insecure-api-key.${this.env.OPENAI_API_KEY}`, 'openai-beta.realtime-v1']);

		openAIClient.addEventListener('open', () => {
			console.log('Connected to OpenAI server.');

			while (this.messageQueue.length > 0) {
				const message = this.messageQueue.shift();
				if (message) {
					openAIClient.send(message);
				}
			}
		});

		openAIClient.addEventListener('message', (event) => {
			if (this.workerSocket && this.workerSocket.readyState === WebSocket.OPEN) {
				this.workerSocket.send(event.data);
			}
		});

		openAIClient.addEventListener('close', () => {
			if (this.workerSocket && this.workerSocket.readyState === WebSocket.OPEN) {
				console.log('OpenAI server closed the connection.');
				this.workerSocket.close();
			}
		});

		return openAIClient;
	}
}
