export const LOCAL_MODEL_ID = 'Qwen2.5-1.5B-Instruct-q4f16_1-MLC';
export const localModel = {
  id: LOCAL_MODEL_ID, name: 'Qwen2.5 1.5B · on-device WebGPU',
  provider: 'webgpu-local', api: 'webgpu-local', baseUrl: '', reasoning: false,
  input: ['text'], contextWindow: 4096, maxTokens: 512,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }
};
