/** Conversation history, as handed to {@link LLM.respond}. */

export type Role = 'system' | 'user' | 'assistant';

export interface Message {
  readonly role: Role;
  readonly content: string;
}
