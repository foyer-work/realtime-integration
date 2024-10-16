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
				return new Response('Expected Upgrade: websocket', { status: 426 });
			}

			const accessToken = url.searchParams.get('token');
			if (!accessToken) {
				return new Response('Missing access token', { status: 400 });
			}

			const id = env.CONVERSATIONS.idFromName(`conversation-${accessToken}`);
			const conversationDO = env.CONVERSATIONS.get(id);
			return conversationDO.fetch(request.clone());
		}

		return new Response('Not Found', { status: 404 });
	},
} satisfies ExportedHandler<Env>;

// Durable Object
export class ConversationDO extends DurableObject {
	env: Env;
	messageQueue: (string | ArrayBuffer)[] = [];
	openAIClient: WebSocket | null = null;
	workerSocket: WebSocket | null = null;
	usageOpenAI: TUsageOpenAI = {
		total_tokens: 0,
		input_tokens: 0,
		output_tokens: 0,
		cost: {
			input: 0,
			output: 0,
		},
	};
	conversations: {
		role: 'user' | 'assistant';
		transcript: string;
	}[] = [];
	feature: TRealtimeVoiceChatFeature = {
		usage: 0,
		resetsAt: 2147452200000,
		limit: 0,
		costPerToken: {
			input: 0.001,
			output: 0.002,
		},
	};

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.env = env;
	}

	async fetch(request: Request) {
		const webSocketPair = new WebSocketPair();
		const [client, server] = Object.values(webSocketPair);

		const accessToken = new URL(request.url).searchParams.get('token') || '';
		await this.handleSession(server, accessToken);

		return new Response(null, {
			status: 101,
			webSocket: client,
		});
	}

	async handleSession(workerWs: WebSocket, accessToken: string) {
		workerWs.accept();
		this.workerSocket = workerWs;

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

				this.sendErrorAndClose(workerWs, logMessage, clientError);
				return;
			} else if ('realtimeVoiceChat' in body.data) {
				this.feature = body.data.realtimeVoiceChat;
			}

			this.openAIClient = this.connectToOpenAI();
		} catch (error) {
			const logMessage = `Error verifying user: ${JSON.stringify(error)}`;
			this.sendErrorAndClose(workerWs, logMessage, clientError);
			return;
		}

		workerWs.addEventListener('message', this.handleWorkerMessage.bind(this));
		workerWs.addEventListener('close', this.handleWorkerClose.bind(this));
		return true;
	}

	handleWorkerMessage(event: MessageEvent) {
		if (!this.openAIClient || this.openAIClient.readyState !== WebSocket.OPEN) {
			this.messageQueue.push(event.data);
			return;
		}

		if (this.isUsageLimitReached()) {
			this.sendErrorAndClose(this.workerSocket!, 'Usage limit reached.', {
				errorType: 'UsageLimitReached',
				message: 'Usage limit reached.',
			});
			return;
		}

		this.openAIClient.send(event.data);
	}

	handleWorkerClose() {
		// await this.dumpConversationToArcane()
		if (this.openAIClient && this.openAIClient.readyState === WebSocket.OPEN) {
			console.log({ usageOpenAI: this.usageOpenAI, conversations: this.conversations });
			this.sendErrorAndClose(this.openAIClient, 'Worker/Client closed the connection.');
		}
	}

	connectToOpenAI() {
		const url = 'wss://api.openai.com/v1/realtime?model=gpt-4o-realtime-preview-2024-10-01';
		const openAIClient = new WebSocket(url, ['realtime', `openai-insecure-api-key.${this.env.OPENAI_API_KEY}`, 'openai-beta.realtime-v1']);

		openAIClient.addEventListener('open', this.handleOpenAIOpen.bind(this));
		openAIClient.addEventListener('message', this.handleOpenAIMessage.bind(this));
		openAIClient.addEventListener('close', this.handleOpenAIClose.bind(this));

		return openAIClient;
	}

	handleOpenAIOpen() {
		console.log('Connected to OpenAI server.');

		while (this.messageQueue.length > 0) {
			const message = this.messageQueue.shift();
			if (message) {
				this.openAIClient!.send(message);
			}
		}
	}

	handleOpenAIMessage(event: MessageEvent) {
		if (this.workerSocket && this.workerSocket.readyState === WebSocket.OPEN) {
			this.workerSocket.send(event.data);
			const evt = JSON.parse(event.data.toString());

			switch (evt.type) {
				case 'response.done':
					const { total_tokens, input_tokens, output_tokens } = evt.response.usage;
					this.updateUsage({ total_tokens, input_tokens, output_tokens });
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
			}
		}
	}

	handleOpenAIClose() {
		if (this.workerSocket && this.workerSocket.readyState === WebSocket.OPEN) {
			this.sendErrorAndClose(this.workerSocket, 'OpenAI server closed the connection.');
		}
	}

	updateUsage({ total_tokens, input_tokens, output_tokens }: { total_tokens: number; input_tokens: number; output_tokens: number }) {
		this.usageOpenAI = {
			total_tokens: this.usageOpenAI.total_tokens + total_tokens,
			input_tokens: this.usageOpenAI.input_tokens + input_tokens,
			output_tokens: this.usageOpenAI.output_tokens + output_tokens,
			cost: {
				input: (this.usageOpenAI.input_tokens + input_tokens) * this.feature.costPerToken.input,
				output: (this.usageOpenAI.output_tokens + output_tokens) * this.feature.costPerToken.output,
			},
		};
	}

	isUsageLimitReached() {
		return this.usageOpenAI.cost.input + this.usageOpenAI.cost.output + this.feature.usage >= this.feature.limit;
	}

	sendErrorAndClose(
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
