package cloud.aster.test;

import com.fasterxml.jackson.databind.JsonNode;
import com.fasterxml.jackson.databind.ObjectMapper;

import java.io.IOException;
import java.io.InputStream;
import java.net.URI;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.nio.file.FileSystem;
import java.nio.file.FileSystems;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.stream.Collectors;
import java.util.stream.Stream;

/**
 * Loads samples from the Aster Lang test corpus packaged inside this jar.
 *
 * <p>Corpus layout (resource-relative):
 * <pre>
 *   corpus/
 *     tier1-equivalence/policies/*.aster (+ inputs/*.cases.json)
 *     tier2-divergent/{java-only,ts-only}/*.aster
 *     tier3-fixtures/&lt;bucket&gt;/*.aster
 * </pre>
 *
 * <p>Each {@code .aster} has a sibling {@code .meta.json}.
 */
public final class CorpusLoader {

    // Ignore unknown meta.json fields so adding new metadata (e.g. evalExempt)
    // never breaks the loader. SampleMeta only models the fields it needs.
    private static final ObjectMapper MAPPER = new ObjectMapper()
        .configure(com.fasterxml.jackson.databind.DeserializationFeature.FAIL_ON_UNKNOWN_PROPERTIES, false);
    private static final String CORPUS_ROOT = "corpus";

    private CorpusLoader() {}

    /** Tier 1 / 2 / 3 / 4. */
    public enum Tier { TIER1, TIER2, TIER3, TIER4 }

    public static final class Sample {
        /** Resource path, e.g. "corpus/tier1-equivalence/policies/01-arithmetic-add.aster". */
        public final String resourcePath;
        public final SampleMeta meta;

        public Sample(String resourcePath, SampleMeta meta) {
            this.resourcePath = resourcePath;
            this.meta = meta;
        }

        public String readSource() {
            try (InputStream is = open(resourcePath)) {
                return new String(is.readAllBytes(), StandardCharsets.UTF_8);
            } catch (IOException e) {
                throw new RuntimeException("Failed to read " + resourcePath, e);
            }
        }

        /** Returns the parsed .cases.json next to this sample (in /inputs/), or null. */
        public JsonNode readCases() {
            String casesPath = resourcePath
                .replace("/policies/", "/inputs/")
                .replaceFirst("\\.aster$", ".cases.json");
            try (InputStream is = CorpusLoader.class.getClassLoader().getResourceAsStream(casesPath)) {
                if (is == null) return null;
                return MAPPER.readTree(is);
            } catch (IOException e) {
                throw new RuntimeException("Failed to read " + casesPath, e);
            }
        }
    }

    public static final class SampleMeta {
        public int tier;
        public List<String> engines = Collections.emptyList();
        public String lexicon;
        public List<String> capabilities = Collections.emptyList();
        public List<String> knownGaps = Collections.emptyList();
        public String divergenceType;
        public String bucket;
        public String source;
        public List<String> tags = Collections.emptyList();
        public String notes;
    }

    private static InputStream open(String resourcePath) {
        InputStream is = CorpusLoader.class.getClassLoader().getResourceAsStream(resourcePath);
        if (is == null) {
            throw new IllegalStateException("Missing corpus resource: " + resourcePath);
        }
        return is;
    }

    /** List every .aster in the bundled corpus. */
    public static List<Sample> listAll() {
        List<String> paths = enumerateAsterResources();
        List<Sample> result = new ArrayList<>(paths.size());
        for (String path : paths) {
            SampleMeta meta = loadMeta(path);
            result.add(new Sample(path, meta));
        }
        return result;
    }

    public static List<Sample> listTier(Tier tier) {
        return listAll().stream()
            .filter(s -> s.meta.tier == tierToInt(tier))
            .collect(Collectors.toList());
    }

    public static List<Sample> listTier3Bucket(String bucket) {
        return listAll().stream()
            .filter(s -> s.meta.tier == 3 && Objects.equals(s.meta.bucket, bucket))
            .collect(Collectors.toList());
    }

    public static Sample readSample(String resourceRelativePath) {
        String full = resourceRelativePath.startsWith(CORPUS_ROOT)
            ? resourceRelativePath
            : CORPUS_ROOT + "/" + resourceRelativePath;
        SampleMeta meta = loadMeta(full);
        return new Sample(full, meta);
    }

    private static int tierToInt(Tier t) {
        switch (t) {
            case TIER1: return 1;
            case TIER2: return 2;
            case TIER3: return 3;
            case TIER4: return 4;
        }
        throw new IllegalStateException("unreachable");
    }

    private static SampleMeta loadMeta(String asterPath) {
        String metaPath = asterPath.replaceFirst("\\.aster$", ".meta.json");
        try (InputStream is = CorpusLoader.class.getClassLoader().getResourceAsStream(metaPath)) {
            if (is == null) {
                throw new IllegalStateException("Missing .meta.json beside " + asterPath);
            }
            return MAPPER.readValue(is, SampleMeta.class);
        } catch (IOException e) {
            throw new RuntimeException("Failed to parse " + metaPath, e);
        }
    }

    /**
     * Walk every .aster resource under corpus/. Works for both exploded
     * classpath directories (Gradle run) and jar entries (Maven artifact).
     */
    private static List<String> enumerateAsterResources() {
        try {
            URL rootUrl = CorpusLoader.class.getClassLoader().getResource(CORPUS_ROOT);
            if (rootUrl == null) {
                throw new IllegalStateException("Corpus resource not on classpath: " + CORPUS_ROOT);
            }
            URI rootUri = rootUrl.toURI();
            Path rootPath;
            FileSystem fs = null;
            if ("jar".equals(rootUri.getScheme())) {
                fs = FileSystems.newFileSystem(rootUri, Map.of());
                rootPath = fs.getPath(CORPUS_ROOT);
            } else {
                rootPath = Path.of(rootUri);
            }
            try (Stream<Path> walk = Files.walk(rootPath)) {
                List<String> out = new ArrayList<>();
                walk.filter(p -> p.toString().endsWith(".aster"))
                    .sorted()
                    .forEach(p -> {
                        // Normalize to forward-slash classpath form.
                        String rel = rootPath.relativize(p).toString().replace('\\', '/');
                        out.add(CORPUS_ROOT + "/" + rel);
                    });
                return out;
            } finally {
                if (fs != null) fs.close();
            }
        } catch (Exception e) {
            throw new RuntimeException("Failed to enumerate corpus", e);
        }
    }
}
