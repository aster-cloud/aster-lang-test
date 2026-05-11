package cloud.aster.test;

import com.fasterxml.jackson.databind.JsonNode;
import org.junit.jupiter.api.DisplayName;
import org.junit.jupiter.api.Test;

import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

@DisplayName("CorpusLoader reads bundled corpus")
class CorpusLoaderTest {

    @Test
    @DisplayName("listAll returns every sample (> 400)")
    void listAll() {
        List<CorpusLoader.Sample> all = CorpusLoader.listAll();
        assertThat(all).hasSizeGreaterThan(400);
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
        assertThat(withCases).isGreaterThanOrEqualTo(20);

        CorpusLoader.Sample s = tier1.stream()
            .filter(x -> x.readCases() != null)
            .findFirst().orElseThrow();
        JsonNode cases = s.readCases();
        assertThat(cases.get("cases").size()).isGreaterThan(0);
    }
}
