import { hashCanonicalContent } from "@tool-evolver/contracts";
import { SignatureExtractor } from "./signature.js";
import type {
  ClusterMetrics,
  ClustererOptions,
  Episode,
  EpisodeSignature,
  WorkflowCluster,
} from "./types.js";

const DEFAULT_SIMILARITY_THRESHOLD = 0.8;
const CLUSTER_ENGINE_VERSION = "1.0.0";

/**
 * Computes Jaccard similarity between two arrays of strings.
 */
function computeJaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  const setA = new Set(a);
  const setB = new Set(b);

  let intersection = 0;
  for (const item of setA) {
    if (setB.has(item)) intersection++;
  }

  const union = setA.size + setB.size - intersection;
  return union === 0 ? 1.0 : intersection / union;
}

/**
 * Computes sequence alignment similarity ratio (Levenshtein-based) between two string arrays.
 */
function computeSequenceSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1.0;
  if (a.length === 0 || b.length === 0) return 0.0;

  // Exact match
  if (a.length === b.length && a.every((v, i) => v === b[i])) {
    return 1.0;
  }

  const m = a.length;
  const n = b.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost);
    }
  }

  const distance = dp[m][n];
  const maxLen = Math.max(m, n);
  return Math.max(0, 1 - distance / maxLen);
}

/**
 * Computes composite structural similarity score between two EpisodeSignatures.
 */
export function computeSignatureSimilarity(sigA: EpisodeSignature, sigB: EpisodeSignature): number {
  // Exact structural hash match
  if (sigA.structuralHash === sigB.structuralHash) {
    return 1.0;
  }

  const opSim = computeSequenceSimilarity(sigA.operationSequence, sigB.operationSequence);
  const classSim = computeJaccardSimilarity(sigA.toolClasses, sigB.toolClasses);
  const argSim = computeJaccardSimilarity(sigA.argumentShapeHashes, sigB.argumentShapeHashes);

  return 0.5 * opSim + 0.3 * classSim + 0.2 * argSim;
}

/**
 * Structural similarity clustering engine for Workflow Episodes.
 */
export class StructuralClusterer {
  private readonly version: string;
  private readonly similarityThreshold: number;
  private readonly extractor: SignatureExtractor;

  constructor(options: ClustererOptions = {}) {
    this.version = options.version ?? CLUSTER_ENGINE_VERSION;
    this.similarityThreshold = options.similarityThreshold ?? DEFAULT_SIMILARITY_THRESHOLD;
    this.extractor = new SignatureExtractor();
  }

  /**
   * Clusters a collection of episodes by structural similarity.
   */
  clusterEpisodes(episodes: Episode[]): WorkflowCluster[] {
    if (!episodes || episodes.length === 0) {
      return [];
    }

    // Extract signatures for all episodes
    const episodePairs: Array<{ episode: Episode; signature: EpisodeSignature }> = episodes.map(
      (ep) => ({
        episode: ep,
        signature: this.extractor.extractSignature(ep),
      }),
    );

    // Group by workspace first
    const byWorkspace = new Map<string, Array<{ episode: Episode; signature: EpisodeSignature }>>();
    for (const pair of episodePairs) {
      const ws = pair.episode.workspaceId || "default-workspace";
      const existing = byWorkspace.get(ws) || [];
      existing.push(pair);
      byWorkspace.set(ws, existing);
    }

    const clusters: WorkflowCluster[] = [];

    for (const [workspaceId, pairs] of byWorkspace.entries()) {
      const workspaceClusters: Array<{
        representativeSignature: EpisodeSignature;
        pairs: Array<{ episode: Episode; signature: EpisodeSignature }>;
      }> = [];

      for (const pair of pairs) {
        let matchedClusterIndex = -1;
        let highestSim = 0;

        for (let i = 0; i < workspaceClusters.length; i++) {
          const c = workspaceClusters[i];
          const sim = computeSignatureSimilarity(pair.signature, c.representativeSignature);
          if (sim >= this.similarityThreshold && sim > highestSim) {
            highestSim = sim;
            matchedClusterIndex = i;
          }
        }

        if (matchedClusterIndex >= 0) {
          workspaceClusters[matchedClusterIndex].pairs.push(pair);
        } else {
          workspaceClusters.push({
            representativeSignature: pair.signature,
            pairs: [pair],
          });
        }
      }

      // Convert to WorkflowCluster objects
      for (const wc of workspaceClusters) {
        const clusterEpisodes = wc.pairs.map((p) => p.episode);
        const cluster = this.buildCluster(workspaceId, wc.representativeSignature, clusterEpisodes);
        clusters.push(cluster);
      }
    }

    return clusters;
  }

  /**
   * Builds an aggregated WorkflowCluster.
   */
  private buildCluster(
    workspaceId: string,
    representativeSignature: EpisodeSignature,
    episodes: Episode[],
  ): WorkflowCluster {
    const episodeCount = episodes.length;
    const sessionIdsSet = new Set<string>();
    const evidenceEventIdsSet = new Set<string>();
    let completedOccurrences = 0;

    let totalDurationMs = 0;
    let totalTokens = 0;
    let totalCostUsd = 0;
    let totalRetries = 0;
    let totalStepCount = 0;

    let firstSeenMs = Number.MAX_SAFE_INTEGER;
    let lastSeenMs = 0;
    let firstSeenAt = episodes[0].startedAt;
    let lastSeenAt = episodes[0].endedAt;

    for (const ep of episodes) {
      sessionIdsSet.add(ep.sessionId);
      if (ep.isCompleted) {
        completedOccurrences++;
      }

      totalDurationMs += ep.metrics.totalDurationMs;
      totalTokens += ep.metrics.totalTokens;
      totalCostUsd += ep.metrics.estimatedCostUsd;
      totalRetries += ep.metrics.retryCount;
      totalStepCount += ep.metrics.stepCount;

      for (const evt of ep.events) {
        evidenceEventIdsSet.add(evt.eventId);
      }

      const startMs = Date.parse(ep.startedAt) || 0;
      const endMs = Date.parse(ep.endedAt) || startMs;

      if (startMs < firstSeenMs) {
        firstSeenMs = startMs;
        firstSeenAt = ep.startedAt;
      }
      if (endMs > lastSeenMs) {
        lastSeenMs = endMs;
        lastSeenAt = ep.endedAt;
      }
    }

    const avgDurationMs = episodeCount > 0 ? Math.round(totalDurationMs / episodeCount) : 0;
    const avgTokens = episodeCount > 0 ? Math.round(totalTokens / episodeCount) : 0;
    const avgStepCount =
      episodeCount > 0 ? Math.round((totalStepCount / episodeCount) * 10) / 10 : 0;

    const metrics: ClusterMetrics = {
      totalDurationMs,
      avgDurationMs,
      totalTokens,
      avgTokens,
      totalCostUsd: Number(totalCostUsd.toFixed(6)),
      totalRetries,
      totalStepCount,
      avgStepCount,
    };

    const structuralHash = representativeSignature.structuralHash;
    const clusterId = `cluster_${workspaceId.replace(/[^a-zA-Z0-9_-]/g, "")}_${structuralHash.slice(0, 16)}`;

    return {
      clusterId,
      workspaceId,
      version: this.version,
      structuralHash,
      representativeSignature,
      episodes,
      episodeCount,
      distinctSessionIds: Array.from(sessionIdsSet),
      completedOccurrences,
      metrics,
      firstSeenAt,
      lastSeenAt,
      evidenceEventIds: Array.from(evidenceEventIdsSet),
    };
  }
}

/**
 * Convenience function to cluster episodes.
 */
export function clusterWorkflowEpisodes(
  episodes: Episode[],
  options?: ClustererOptions,
): WorkflowCluster[] {
  const clusterer = new StructuralClusterer(options);
  return clusterer.clusterEpisodes(episodes);
}
