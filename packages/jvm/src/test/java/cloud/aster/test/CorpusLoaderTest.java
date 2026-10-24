package cloud.aster.test;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("CorpusLoader reads bundled corpus")
class CorpusLoaderTest {

    @Test
    @DisplayName("listAll returns the full corpus (≥ 300 after dedup)")
    void listAll() {
        List<CorpusLoader.Sample> all = CorpusLoader.listAll();
        assertThat(all).hasSizeGreaterThanOrEqualTo(300);
    }

    @Test
    @DisplayName("listTier(TIER1) returns ≥ 160 samples, all engines={java,ts}")
    void tier1() {
        List<CorpusLoader.Sample> tier1 = CorpusLoader.listTier(CorpusLoader.Tier.TIER1);
        assertThat(tier1.size()).isGreaterThanOrEqualTo(160);
        for (CorpusLoader.Sample s : tier1) {
            assertThat(s.meta.engines).containsExactlyInAnyOrder("java", "ts");
        }
    }

    @Test
    @DisplayName("listTier3Bucket(\"lossless\") returns the pretty-printer goldens")
    void tier3Bucket() {
        List<CorpusLoader.Sample> lossless = CorpusLoader.listTier3Bucket("lossless");
        assertThat(lossless.size()).isGreaterThanOrEqualTo(25);
    }

    @Test
    @DisplayName("readSource returns Aster source")
    void readSource() {
        List<CorpusLoader.Sample> tier1 = CorpusLoader.listTier(CorpusLoader.Tier.TIER1);
        String src = tier1.get(0).readSource();
        assertThat(src).containsAnyOf("Module", "Rule");
    }

    @Test
    @DisplayName("at least one tier1 sample has .cases.json golden")
    void readCases() {
        List<CorpusLoader.Sample> tier1 = CorpusLoader.listTier(CorpusLoader.Tier.TIER1);
        long withCases = tier1.stream().filter(s -> s.readCases() != null).count();
        // Post-reclassify baseline: 15 of the original 23 cases.json files
        // survived as tier1 (the other 8 had If:-block syntax that Java
        // actually rejects and were moved to tier2/ts-only).
        assertThat(withCases).isGreaterThanOrEqualTo(15);

        CorpusLoader.Sample s = tier1.stream()
            .filter(x -> x.readCases() != null)
            .findFirst().orElseThrow();
        JsonNode cases = s.readCases();
        assertThat(cases.get("cases").size()).isGreaterThan(0);
    }

    @Test
    @DisplayName("SOC2 demo keeps explicit parameter and timestamp type declarations")
    void soc2AuditDemoTypes() {
        CorpusLoader.Sample sample = CorpusLoader.listTier(CorpusLoader.Tier.TIER1).stream()
            .filter(x -> x.resourcePath.endsWith("/soc2-audit-demo.aster"))
            .findFirst().orElseThrow();
        String source = sample.readSource();

        assertThat(source).contains("timestamp as Text,");
        for (String signature : List.of(
            "Rule verify_one_record given state as ChainState, record as AuditRecord, produce. It performs cpu:",
            "Rule verify_three_records given r1 as AuditRecord, r2 as AuditRecord, r3 as AuditRecord, produce. It performs cpu:",
            "Rule compute_hash given record as AuditRecord, produce. It performs cpu:",
            "Rule verify_record_integrity given record as AuditRecord, produce. It performs cpu:",
            "Rule verify_chain_link given record as AuditRecord, expected_prev_hash as Text, produce:",
            "Rule verify_two_records given r1 as AuditRecord, r2 as AuditRecord, produce. It performs cpu:",
            "Rule verify_audit_chain given record as AuditRecord, produce. It performs cpu:",
            "Rule generate_soc2_report given tenant_id as Text, verification as ChainVerificationResult, produce:",
            "Rule create_genesis_record given tenant_id as Text, produce. It performs cpu:",
            "Rule append_audit_record given prev as AuditRecord, event_type as Text, policy_func as Text, success as Bool, produce. It performs cpu:"
        )) {
            assertThat(source).contains(signature);
        }
        assertThat(source).contains("Let msg be \"Hash integrity failed at record \" plus record.record_number.");
        assertThat(source).contains("Let linkMsg be \"Chain link broken at record \" plus record.record_number.");
        assertThat(source).doesNotContain("Let msg be \"Chain link broken at record \"");
    }
}
