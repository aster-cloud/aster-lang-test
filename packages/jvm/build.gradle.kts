// aster-lang-test JVM artifact
//
// Bundles the corpus/ directory (sibling to packages/) into the jar at root,
// so consumers can read it via ClassLoader.getResource("corpus/...").

plugins {
    `java-library`
    `maven-publish`
}

group = "cloud.aster-lang"

// corpus jar 版本 = 共享版本目录的 asterLang（JVM 生态单一版本源，ADR 0012/0023 §9）。
// 不硬编码字面量——字面量是版本漂移的来源（test:jvm 在 ecosystem 1.0.6 发车中曾整仓被漏）。
// 从 catalog 派生让版本永远跟随 ecosystemVersion。与 core/runtime/validation/truffle 同构。
version = extensions.getByType<VersionCatalogsExtension>()
    .named("asterLibs").findVersion("asterLang").get().requiredVersion

java {
    toolchain {
        languageVersion = JavaLanguageVersion.of(25)
    }
    withSourcesJar()
}

repositories {
    mavenLocal()
    mavenCentral()
}

dependencies {
    implementation("com.fasterxml.jackson.core:jackson-databind:2.18.2")

    testImplementation("org.junit.jupiter:junit-jupiter:6.0.0")
    testImplementation("org.assertj:assertj-core:3.27.3")
    testRuntimeOnly("org.junit.platform:junit-platform-launcher")
}

// Copy the monorepo-root corpus/ into this module's resources at build time so
// it ends up inside the published jar.
val corpusSourceDir = layout.projectDirectory.dir("../../corpus")
val corpusStaging = layout.buildDirectory.dir("corpus-resources/corpus")

val syncCorpus by tasks.registering(Sync::class) {
    from(corpusSourceDir)
    into(corpusStaging)
}

sourceSets {
    main {
        resources {
            srcDir(syncCorpus.map { it.destinationDir.parentFile })
        }
    }
}

tasks.named<ProcessResources>("processResources") {
    dependsOn(syncCorpus)
}

tasks.test {
    useJUnitPlatform()
    testLogging {
        events("passed", "failed", "skipped")
    }
}

publishing {
    publications {
        create<MavenPublication>("mavenJava") {
            from(components["java"])
            artifactId = "aster-lang-test"
            pom {
                name.set("Aster Lang Test Corpus")
                description.set("Shared test corpus for Aster Lang dual-engine equivalence.")
                licenses {
                    license {
                        name.set("Apache-2.0")
                        url.set("https://www.apache.org/licenses/LICENSE-2.0")
                    }
                }
            }
        }
    }
    repositories {
        mavenLocal()
        maven {
            name = "GitHubPackages"
            url = uri("https://maven.pkg.github.com/aster-cloud/aster-lang-test")
            credentials {
                username = System.getenv("GITHUB_ACTOR") ?: ""
                password = System.getenv("GITHUB_TOKEN") ?: ""
            }
        }
    }
}
