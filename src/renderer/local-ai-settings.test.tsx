import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import {
  LocalAiSettings,
  isOllamaEndpoint,
  localAiConnectionMessage,
} from './LocalAiSettings';

describe('Local AI settings', () => {
  it('recognizes only the local Ollama quick-path endpoint', () => {
    expect(isOllamaEndpoint('http://127.0.0.1:11434/v1')).toBe(true);
    expect(isOllamaEndpoint('http://localhost:11434/v1')).toBe(true);
    expect(isOllamaEndpoint('http://10.1.2.3:11434/v1')).toBe(false);
    expect(isOllamaEndpoint('https://example.com/v1')).toBe(false);
  });

  it('makes one-click Ollama setup primary and keeps custom endpoints advanced', () => {
    const markup = renderToStaticMarkup(<LocalAiSettings />);

    expect(markup).toContain('Ollama on this computer');
    expect(markup).toContain('Connect Ollama');
    expect(markup).toContain('Recommended · no API key needed');
    expect(markup).toContain('Connect another OpenAI-compatible endpoint');
    expect(markup.match(/<details/g)).toHaveLength(1);
  });

  it('distinguishes one endpoint from the models available through it', () => {
    expect(localAiConnectionMessage(5, 'gemma3:4b', true)).toBe(
      'Ollama is connected. 5 models are available; Sotto will use gemma3:4b for summaries.',
    );
  });
});
