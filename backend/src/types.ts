export type Role = 'admin' | 'adult' | 'child';
export type MemoryType = 'photo' | 'video' | 'audio' | 'text' | 'doc';
export type ConsentType = 'voice' | 'avatar' | 'posthumous';
export type ConsentStatus = 'pending' | 'approved' | 'rejected';
export type PosthumousStatus = 'authorization_requested' | 'under_review' | 'approved' | 'rejected' | 'active' | 'suspended' | 'deleted';

export interface Family { id: string; name: string; createdAt: string; }
export interface User { id: string; familyId: string; name: string; role: Role; email: string; passwordHash: string; isChildAccount: boolean; createdAt: string; }
export interface FamilyMember { id: string; familyId: string; name: string; relationship: string; isDeceased: boolean; posthumousStatus: PosthumousStatus; createdAt: string; }
export interface Memory { id: string; familyMemberId: string; uploaderId: string; type: MemoryType; title: string; storagePath?: string; originalName?: string; mimeType?: string; transcript?: string; tags: string[]; consentStatus: ConsentStatus; capturedAt?: string; createdAt: string; processedAt?: string; processingStatus?: 'processing' | 'processed' | 'needs_processor'; }
export interface MemoryEmbedding { id: string; memoryId: string; chunkText: string; embedding: number[]; metadata: Record<string, unknown>; }
export interface ConsentRecord { id: string; familyMemberId: string; type: ConsentType; grantedBy: string; grantedAt: string; legalBasis?: string; revokedAt?: string; }
export interface VoiceModel { id: string; familyMemberId: string; sourceMemoryId: string; consentRecordId: string; modelPath: string; referenceAudioPath?: string; promptText?: string; provider?: string; status: 'active' | 'deleted'; createdAt: string; }
export interface Conversation { id: string; familyId: string; userId: string; familyMemberId: string; createdAt: string; }
export interface Message { id: string; conversationId: string; role: 'user' | 'assistant'; content: string; sourceMemoryIds: string[]; sourceLearningIds?: string[]; createdAt: string; aiGenerated?: boolean; }
export type LearningKind = 'fact' | 'style' | 'boundary' | 'skill';
export type LearningStatus = 'pending' | 'approved' | 'rejected';
export interface LearningItem { id: string; familyId: string; familyMemberId: string; kind: LearningKind; title: string; content: string; confidence: number; status: LearningStatus; sourceConversationId?: string; sourceMessageIds: string[]; sourceMemoryIds: string[]; createdAt: string; reviewedAt?: string; reviewedBy?: string; }
export type TrainingJobStatus = 'queued' | 'running' | 'completed' | 'failed';
export interface TrainingJob { id: string; familyId: string; status: TrainingJobStatus; baseModel: string; datasetPath: string; outputPath: string; sampleCount?: number; automatic?: boolean; adapterPath?: string; command?: string; log?: string; error?: string; createdAt: string; startedAt?: string; finishedAt?: string; }
export interface AuditLog { id: string; familyId: string; actorId?: string; action: string; targetType: string; targetId?: string; metadata: Record<string, unknown>; createdAt: string; }
export interface MetricEvent { id: string; familyId?: string; kind: string; value: number; metadata?: Record<string, unknown>; createdAt: string; }
export interface StoreState { families: Family[]; users: User[]; familyMembers: FamilyMember[]; memories: Memory[]; memoryEmbeddings: MemoryEmbedding[]; consentRecords: ConsentRecord[]; voiceModels: VoiceModel[]; conversations: Conversation[]; messages: Message[]; learningItems: LearningItem[]; trainingJobs: TrainingJob[]; auditLog: AuditLog[]; metricEvents: MetricEvent[]; }
