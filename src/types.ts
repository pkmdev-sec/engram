/**
 * Core types for pi-brain-agent.
 *
 * Every module imports from here. Changes to these types cascade everywhere,
 * so they are frozen early and validated rigorously.
 */

// -- Knowledge Entry Categories --

export type EntryCategory =
	| "constraint"
	| "architecture"
	| "pattern"
	| "gotcha"
	| "dependency"
	| "active-work"
	| "file-purpose"
	| "failed-approach"
	| "user-preference";

/** Categories that produce imperative-voice entries (counted toward imperative budget). */
export const IMPERATIVE_CATEGORIES: ReadonlySet<EntryCategory> = new Set([
	"constraint",
	"gotcha",
	"failed-approach",
]);

/** Categories that produce informational-voice entries. */
export const INFORMATIONAL_CATEGORIES: ReadonlySet<EntryCategory> = new Set([
	"architecture",
	"pattern",
	"dependency",
	"active-work",
	"file-purpose",
	"user-preference",
]);

// -- Knowledge Entry --

export interface SourceSession {
	readonly tool: "claude" | "pi" | "codex" | "opencode" | "hermes";
	readonly sessionId: string;
	/** SHA-256 of the sanitized conversation chunk that produced this entry. */
	readonly conversationHash: string;
}

export interface VerificationState {
	readonly lastChecked: string;
	readonly filesExist: boolean;
	readonly filesModified: boolean;
}

export interface KnowledgeEntry {
	readonly id: string;
	readonly timestamp: string;
	readonly projectId: string;

	readonly category: EntryCategory;
	readonly summary: string;
	readonly reasoning: string;
	readonly confidence: number;

	readonly files: readonly string[];
	readonly topics: readonly string[];

	readonly importance: number;
	readonly feedbackScore: number;

	readonly sourceSession: SourceSession;

	readonly expiresAt: string | null;
	readonly verified: VerificationState | null;

	/** True if this entry lives in the global brain (cross-project). */
	readonly crossProject?: boolean;
	/** Project IDs that contributed to this global entry (for audit trail). */
	readonly promotedFrom?: readonly string[];
}

// -- Brain Index --

export interface BrainIndex {
	readonly projectId: string;
	readonly lastUpdated: string;
	readonly entryCount: number;
	readonly byTopic: Readonly<Record<string, readonly string[]>>;
	readonly byFile: Readonly<Record<string, readonly string[]>>;
	readonly byCategory: Readonly<Record<string, readonly string[]>>;
}

// -- Injection State (per-session, in-memory) --

export interface InjectionState {
	sessionId: string;
	injectedEntryIds: Set<string>;
	injectedFiles: Set<string>;
	injectedTopics: Set<string>;
	injectionTimestamp: string;
}

// -- Distiller Output (raw from LLM, before validation) --

export interface RawDistillerEntry {
	category: string;
	summary: string;
	reasoning: string;
	confidence: number;
	files: string[];
	topics: string[];
	importance: number;
	expiresAt: string | null;
}

// -- Ranked Entry (entry with computed score for injection) --

export interface RankedEntry {
	readonly entry: KnowledgeEntry;
	readonly score: number;
	readonly isStale: boolean;
	readonly filesExist: boolean;
}

// -- Configuration --

export interface DistillationConfig {
	readonly model: string;
	readonly maxEntriesPerSession: number;
	readonly minConfidence: number;
}

export interface CompactionConfig {
	readonly model: string;
	readonly maxEntriesPerProject: number;
	readonly triggerThreshold: number;
	readonly maxDaysBetweenCompactions: number;
}

export interface InjectionConfig {
	readonly maxImperativeEntries: number;
	readonly maxInformationalEntries: number;
	readonly importanceThreshold: number;
	readonly decayDays30: number;
	readonly decayDays90: number;
}

export interface DriftConfig {
	readonly overlapThreshold: number;
}

export interface FeedbackConfig {
	readonly boostPerUse: number;
	readonly penaltyPerIgnore: number;
	readonly maxFeedbackScore: number;
	readonly minFeedbackScore: number;
}

export interface GlobalConfig {
	readonly enabled: boolean;
	readonly maxEntries: number;
	/** Per-category importance multipliers for global entries. */
	readonly categoryMultipliers: Readonly<Record<string, number>>;
}

export interface AgentConfig {
	readonly distillation: DistillationConfig;
	readonly compaction: CompactionConfig;
	readonly injection: InjectionConfig;
	readonly driftDetection: DriftConfig;
	readonly feedback: FeedbackConfig;
	readonly global: GlobalConfig;
}

export const DEFAULT_CONFIG: AgentConfig = {
	distillation: {
		model: "claude-opus-4-6",
		maxEntriesPerSession: 10,
		minConfidence: 0.7,
	},
	compaction: {
		model: "claude-sonnet-4-6",
		maxEntriesPerProject: 100,
		triggerThreshold: 100,
		maxDaysBetweenCompactions: 60,
	},
	injection: {
		maxImperativeEntries: 20,
		maxInformationalEntries: 15,
		importanceThreshold: 0.5,
		decayDays30: 0.8,
		decayDays90: 0.5,
	},
	driftDetection: {
		overlapThreshold: 0.3,
	},
	global: {
		enabled: false,
		maxEntries: 35,
		categoryMultipliers: {
			"user-preference": 1.0,
			"dependency": 0.85,
			"failed-approach": 0.8,
			"gotcha": 0.75,
			"pattern": 0.6,
			"constraint": 0.5,
			"architecture": 0.4,
			"active-work": 0.3,
			"file-purpose": 0.3,
		},
	},
	feedback: {
		boostPerUse: 0.05,
		penaltyPerIgnore: 0.05,
		maxFeedbackScore: 0.3,
		minFeedbackScore: -0.3,
	},
};

// -- Session Transcript (input to distiller) --

export interface SessionMessage {
	readonly role: "user" | "assistant" | "tool-result" | "system";
	readonly content: string;
	readonly timestamp?: string;
	readonly model?: string;
}

export interface SessionTranscript {
	readonly id: string;
	readonly source: string;
	readonly messages: readonly SessionMessage[];
	readonly projectPath?: string;
}
