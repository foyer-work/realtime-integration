import { DurableObject } from 'cloudflare:workers';

type TUsageOpenAI = {
	total_tokens: number;
	input_tokens: number;
	output_tokens: number;
	cost: {
		input: number;
		output: number;
	};
};

type TRealtimeVoiceChatFeature = {
	usage: number;
	resetsAt: number;
	limit: number;
	costPerToken: {
		input: number;
		output: number;
	};
};

type TApiResponse = {
	status: string;
	data:
		| {
				type: string;
				message: string;
		  }
		| {
				realtimeVoiceChat: TRealtimeVoiceChatFeature;
		  };
};

// Worker
export default {
	async fetch(request, env, ctx): Promise<Response> {
		const url = new URL(request.url);
		if (url.pathname === '/websocket') {
			const upgradeHeader = request.headers.get('Upgrade');
			if (!upgradeHeader || upgradeHeader !== 'websocket') {
				return new Response('Durable Object expected Upgrade: websocket', { status: 426 });
			}

			// use this for arcane
			const accessToken = url.searchParams.get('token');
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
	usageOpenAI: TUsageOpenAI;
	conversations: {
		role: 'user' | 'assistant';
		transcript: string;
	}[];
	feature: TRealtimeVoiceChatFeature;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
		this.openAIClient = null;
		this.workerSocket = null;
		this.messageQueue = [];
		this.conversations = [];
		this.usageOpenAI = {
			total_tokens: 0,
			input_tokens: 0,
			output_tokens: 0,
			cost: {
				input: 0,
				output: 0,
			},
		};
		this.feature = {
			usage: 0,
			resetsAt: 2147452200000,
			limit: 0,
			costPerToken: {
				input: 0.001,
				output: 0.002,
			},
		};
	}

	fetch(request: Request) {
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		const accessToken = new URL(request.url).searchParams.get('token');
		this.handleSession(server, accessToken);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async handleSession(workerWs: WebSocket, accessToken: string | null) {
		workerWs.accept();
		this.workerSocket = workerWs;

		if (!accessToken) {
			this.closeWithError(workerWs, 'No access token provided.');
			return;
		}

		let clientError = { errorType: 'Unknown', message: 'Unexpected Error occured' };
		try {
			const verificationResponse = await fetch('http://localhost:8080/v1/user/realtime/user-verification', {
				method: 'GET',
				headers: {
					Authorization: `Bearer ${accessToken}`,
					'x-merlin-version': 'socket-merlin',
				},
			});

			const body: TApiResponse = await verificationResponse.json();
			if (!verificationResponse.ok) {
				if ('type' in body.data) {
					clientError = { errorType: body.data.type, message: body.data.message };
				}
				const logMessage = `Error verifying user: ${JSON.stringify(body)}`;

				this.closeWithError(workerWs, logMessage, clientError);
				return;
			} else if ('realtimeVoiceChat' in body.data) {
				this.feature = body.data.realtimeVoiceChat;
			}

			this.openAIClient = this.connectToOpenAI();
		} catch (error) {
			const logMessage = `Error verifying user: ${JSON.stringify(error)}`;
			this.closeWithError(workerWs, logMessage, clientError);
		}

		workerWs.addEventListener('message', (event) => {
			/**
			 * Send the message to OpenAI
			 */

			console.log({
				inputEventToOpenAI: event.data,
			});
			if (!this.openAIClient || this.openAIClient.readyState !== WebSocket.OPEN) {
				this.messageQueue.push(event.data);
			} else {
				if (this.usageOpenAI.cost.input + this.usageOpenAI.cost.output + this.feature.usage >= this.feature.limit) {
					this.closeWithError(workerWs, 'Usage limit reached.', {
						errorType: 'UsageLimitReached',
						message: 'Usage limit reached.',
					});
					return;
				}
				this.openAIClient.send(event.data);
			}
		});

		workerWs.addEventListener('close', () => {
			/**
			 * Close the openAI socket
			 * Store the conversation to the database (Arcane)
			 */

			// await this.dumpConversationToArcane()
			if (this.openAIClient && this.openAIClient.readyState === WebSocket.OPEN) {
				console.log({ usageOpenAI: this.usageOpenAI, conversations: this.conversations });
				this.closeWithError(this.openAIClient, 'Worker/Client closed the connection.');
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
				const evt = JSON.parse(event.data.toString());

				switch (evt.type) {
					case 'response.done':
						const { total_tokens, input_tokens, output_tokens } = evt.response.usage;
						this.usageOpenAI = {
							total_tokens: this.usageOpenAI.total_tokens + total_tokens,
							input_tokens: this.usageOpenAI.input_tokens + input_tokens,
							output_tokens: this.usageOpenAI.output_tokens + output_tokens,
							cost: {
								input: (this.usageOpenAI.input_tokens + input_tokens) * this.feature.costPerToken.input,
								output: (this.usageOpenAI.output_tokens + output_tokens) * this.feature.costPerToken.output,
							},
						};
						break;
					case 'conversation.item.input_audio_transcription.completed':
						this.conversations.push({
							role: 'user',
							transcript: evt.transcript,
						});
						break;
					case 'response.audio_transcript.done':
						this.conversations.push({
							role: 'assistant',
							transcript: evt.transcript,
						});
						break;
					default:
						break;
				}
			}
		});

		openAIClient.addEventListener('close', () => {
			if (this.workerSocket && this.workerSocket.readyState === WebSocket.OPEN) {
				this.closeWithError(this.workerSocket, 'OpenAI server closed the connection.');
			}
		});

		return openAIClient;
	}

	closeWithError(
		socket: WebSocket,
		logMessage: string,
		clientError?: {
			errorType: string;
			message: string;
		}
	) {
		if (clientError) {
			socket.send(JSON.stringify({ type: 'error', errorType: clientError.errorType, message: clientError.message }));
		}
		console.log(`[ConversationDO] ${logMessage}`);
		socket.close();
	}
}
