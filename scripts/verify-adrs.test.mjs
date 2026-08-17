import path from "node:path";
import process from "node:process";
import { describe, expect, it } from "vitest";
import {
  CANONICAL_TERMS,
  REQUIRED_ARCHITECTURE_DOCS,
  VALID_STATUSES,
  parseAdr,
  validateAdrContent,
  validateArchitectureDocs,
  validateGlossaryTerms,
  validateMarkdownLinks,
  validateSequentialNumbering,
  verifyAdrs,
} from "./verify-adrs.mjs";

describe("verify-adrs", () => {
  const rootDir = process.cwd();

  it("successfully validates all repository ADRs and architecture documents", () => {
    const result = verifyAdrs(rootDir);

    if (!result.valid) {
      console.error("ADR verification failures:", result.violations);
    }

    expect(result.valid).toBe(true);
    expect(result.violations).toHaveLength(0);
    expect(result.stats.adrCount).toBeGreaterThanOrEqual(10);
    expect(result.stats.archDocCount).toBeGreaterThanOrEqual(4);
  });

  describe("parseAdr", () => {
    it("parses valid ADR metadata correctly", () => {
      const adr1 = parseAdr("docs/adr/0001-v1-topology.md", rootDir);
      expect(adr1.number).toBe(1);
      expect(adr1.numberStr).toBe("0001");
      expect(adr1.slug).toBe("v1-topology");
      expect(adr1.status).toBe("accepted");
      expect(adr1.date).toBe("2026-08-17");
      expect(adr1.title).toContain("ADR 0001");
      expect(adr1.sections).toContain("Context and Problem Statement");
      expect(adr1.sections).toContain("Decision");
      expect(adr1.sections).toContain("Consequences");
    });
  });

  describe("validateSequentialNumbering", () => {
    it("passes when ADRs are strictly sequential from 0001", () => {
      const mockAdrs = [
        { file: "docs/adr/0001-first.md", number: 1, numberStr: "0001" },
        { file: "docs/adr/0002-second.md", number: 2, numberStr: "0002" },
        { file: "docs/adr/0003-third.md", number: 3, numberStr: "0003" },
      ];
      const violations = validateSequentialNumbering(mockAdrs);
      expect(violations).toHaveLength(0);
    });

    it("detects when first ADR does not start at 0001", () => {
      const mockAdrs = [
        { file: "docs/adr/0002-second.md", number: 2, numberStr: "0002" },
        { file: "docs/adr/0003-third.md", number: 3, numberStr: "0003" },
      ];
      const violations = validateSequentialNumbering(mockAdrs);
      expect(violations.some((v) => v.message.includes("First ADR must be 0001"))).toBe(true);
    });

    it("detects sequence gaps in ADR numbering", () => {
      const mockAdrs = [
        { file: "docs/adr/0001-first.md", number: 1, numberStr: "0001" },
        { file: "docs/adr/0003-third.md", number: 3, numberStr: "0003" },
      ];
      const violations = validateSequentialNumbering(mockAdrs);
      expect(violations.some((v) => v.rule === "SEQUENCE" && v.message.includes("gap"))).toBe(true);
    });

    it("detects duplicate ADR numbers", () => {
      const mockAdrs = [
        { file: "docs/adr/0001-first.md", number: 1, numberStr: "0001" },
        { file: "docs/adr/0001-duplicate.md", number: 1, numberStr: "0001" },
      ];
      const violations = validateSequentialNumbering(mockAdrs);
      expect(violations.some((v) => v.message.includes("Duplicate ADR number"))).toBe(true);
    });

    it("detects invalid filename formats", () => {
      const mockAdrs = [{ file: "docs/adr/001-short-number.md", number: 1, numberStr: "001" }];
      const violations = validateSequentialNumbering(mockAdrs);
      expect(violations.some((v) => v.rule === "NAMING")).toBe(true);
    });

    it("reports empty ADR directory", () => {
      const violations = validateSequentialNumbering([]);
      expect(violations).toHaveLength(1);
      expect(violations[0].rule).toBe("SEQUENCE");
    });
  });

  describe("validateAdrContent", () => {
    it("detects missing or invalid statuses", () => {
      const mockAdrs = [
        {
          file: "docs/adr/0001-test.md",
          title: "ADR 0001: Test",
          date: "2026-08-17",
          status: "invalid_status",
          sections: ["Context", "Decision", "Consequences"],
        },
      ];
      const violations = validateAdrContent(mockAdrs);
      expect(violations.some((v) => v.rule === "STATUS")).toBe(true);
    });

    it("accepts all canonical statuses", () => {
      for (const status of VALID_STATUSES) {
        const mockAdrs = [
          {
            file: "docs/adr/0001-test.md",
            title: "ADR 0001: Test",
            date: "2026-08-17",
            status,
            sections: ["Context", "Decision", "Consequences"],
          },
        ];
        const violations = validateAdrContent(mockAdrs);
        expect(violations.filter((v) => v.rule === "STATUS")).toHaveLength(0);
      }
    });

    it("detects missing date or title", () => {
      const mockAdrs = [
        {
          file: "docs/adr/0001-test.md",
          title: "",
          date: "",
          status: "accepted",
          sections: ["Context", "Decision", "Consequences"],
        },
      ];
      const violations = validateAdrContent(mockAdrs);
      expect(violations.some((v) => v.rule === "TITLE")).toBe(true);
      expect(violations.some((v) => v.rule === "METADATA" && v.message.includes("Date"))).toBe(
        true,
      );
    });

    it("detects missing mandatory sections", () => {
      const mockAdrs = [
        {
          file: "docs/adr/0001-test.md",
          title: "ADR 0001: Test",
          date: "2026-08-17",
          status: "accepted",
          sections: ["Only Background"],
        },
      ];
      const violations = validateAdrContent(mockAdrs);
      expect(violations.some((v) => v.message.includes("Context"))).toBe(true);
      expect(violations.some((v) => v.message.includes("Decision"))).toBe(true);
      expect(violations.some((v) => v.message.includes("Consequences"))).toBe(true);
    });
  });

  describe("validateArchitectureDocs", () => {
    it("validates all required architecture docs are present", () => {
      const violations = validateArchitectureDocs(rootDir);
      expect(violations).toHaveLength(0);
    });

    it("verifies required list includes all core documents", () => {
      expect(REQUIRED_ARCHITECTURE_DOCS).toContain("overview.md");
      expect(REQUIRED_ARCHITECTURE_DOCS).toContain("boundaries.md");
      expect(REQUIRED_ARCHITECTURE_DOCS).toContain("glossary.md");
      expect(REQUIRED_ARCHITECTURE_DOCS).toContain("nfr.md");
    });
  });

  describe("validateGlossaryTerms", () => {
    it("verifies all canonical terms are defined in glossary.md", () => {
      const glossaryPath = path.join(rootDir, "docs/architecture/glossary.md");
      const violations = validateGlossaryTerms(glossaryPath, [], rootDir);
      expect(violations).toHaveLength(0);
    });

    it("verifies expected canonical glossary terms list", () => {
      expect(CANONICAL_TERMS).toContain("Gateway");
      expect(CANONICAL_TERMS).toContain("Observer");
      expect(CANONICAL_TERMS).toContain("Runtime");
      expect(CANONICAL_TERMS).toContain("Evolution Engine");
      expect(CANONICAL_TERMS).toContain("Candidate");
      expect(CANONICAL_TERMS).toContain("Tool Version");
      expect(CANONICAL_TERMS).toContain("Activation");
      expect(CANONICAL_TERMS).toContain("Canary");
      expect(CANONICAL_TERMS).toContain("Promotion");
      expect(CANONICAL_TERMS).toContain("Rollback");
      expect(CANONICAL_TERMS).toContain("Workspace Scope");
      expect(CANONICAL_TERMS).toContain("Device");
      expect(CANONICAL_TERMS).toContain("Capability Envelope");
    });
  });

  describe("validateMarkdownLinks", () => {
    it("validates all relative links in ADRs and architecture docs resolve", () => {
      const adrFiles = Array.from({ length: 10 }, (_, i) => {
        const num = String(i + 1).padStart(4, "0");
        return `docs/adr/${num}-*.md`;
      });
      const violations = validateMarkdownLinks(
        [
          "docs/architecture/overview.md",
          "docs/architecture/boundaries.md",
          "docs/architecture/glossary.md",
          "docs/architecture/nfr.md",
          "docs/adr/0001-v1-topology.md",
          "docs/adr/0002-daemon-and-worker-isolation.md",
          "docs/adr/0003-supported-harnesses-and-platforms.md",
          "docs/adr/0004-evolution-scope-and-autonomy.md",
          "docs/adr/0005-privacy-data-boundaries.md",
          "docs/adr/0006-storage-and-runtimes.md",
          "docs/adr/0007-capability-envelope-and-security.md",
          "docs/adr/0008-canary-and-rollback.md",
          "docs/adr/0009-nfr-and-performance-targets.md",
          "docs/adr/0010-adr-governance.md",
        ],
        rootDir,
      );
      expect(violations).toHaveLength(0);
    });
  });
});
