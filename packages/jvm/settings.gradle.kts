rootProject.name = "aster-lang-test"

dependencyResolutionManagement {
    // 共享版本目录（aster-lang-platform，ADR 0012/0023 §9）：corpus jar 版本从 catalog
    // 的 asterLang 派生（消除字面量漂移——test:jvm 在 ecosystem 1.0.6 发车中曾整仓被漏）。
    // 本制品零 aster 依赖，catalog 仅为版本派生而引入；CI/release 先 platform
    // publishToMavenLocal 再构建。drift gate（check-artifact.py）的 pin 校验对子目录制品
    // 先查 artifactPath(packages/jvm)，故 pin 须在此 settings。
    @Suppress("UnstableApiUsage")
    repositories {
        mavenLocal()
        mavenCentral()
    }
    versionCatalogs {
        create("asterLibs") {
            from("cloud.aster-lang:aster-lang-platform:1.0.10")
        }
    }
}
