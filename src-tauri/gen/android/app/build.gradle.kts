import java.io.File
import java.util.Properties

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
    id("rust")
}

val tauriProperties = Properties().apply {
    val propFile = file("tauri.properties")
    if (propFile.exists()) {
        propFile.inputStream().use { load(it) }
    }
}

// Release signing, loaded from outside the repository.
//
// Two rules decide the shape of this. The keystore and its password must never
// be reachable from the project tree -- not gitignored inside it, outside it --
// because the cost of one `git add -A` on a signing key is not a bad commit, it
// is a key that has to be treated as burned and an app that can never be
// updated again. And `gen/` is Tauri's, regenerated on a whim, so a secret
// parked in here would be silently erased at the worst possible moment.
//
// So: `~/.facet-signing/keystore.properties`, or wherever FACET_SIGNING points.
// It names the keystore and holds the passwords, and nothing in this repository
// ever contains either.
//
// Without that file the release build is simply unsigned, exactly as it was
// before. Someone who clones this and runs a release build should get a working
// unsigned APK, not a failure about a key they were never going to have.
val signingProps = Properties().apply {
    val candidates = listOfNotNull(
        System.getenv("FACET_SIGNING")?.let { File(it) },
        File(System.getProperty("user.home"), ".facet-signing/keystore.properties"),
    )
    candidates.firstOrNull { it.exists() }?.inputStream()?.use { load(it) }
}
val haveSigningKey = signingProps.getProperty("storeFile")?.let { File(it).exists() } == true

android {
    compileSdk = 36
    namespace = "com.iraslabs.facet"
    defaultConfig {
        manifestPlaceholders["usesCleartextTraffic"] = "false"
        applicationId = "com.iraslabs.facet"
        minSdk = 24
        targetSdk = 36
        versionCode = tauriProperties.getProperty("tauri.android.versionCode", "1").toInt()
        versionName = tauriProperties.getProperty("tauri.android.versionName", "1.0")
    }
    signingConfigs {
        if (haveSigningKey) {
            create("release") {
                storeFile = File(signingProps.getProperty("storeFile"))
                storePassword = signingProps.getProperty("storePassword")
                keyAlias = signingProps.getProperty("keyAlias")
                keyPassword = signingProps.getProperty("keyPassword")
                // v1 is the old JAR signing, entry by entry, and it is the
                // only thing Android 6 and earlier can verify. minSdk here is
                // 24 -- which is the release v2 signing arrived in -- so every
                // device that can install this app verifies v2, and AGP drops
                // v1 on its own however this flag is set. It stays true only so
                // that lowering minSdk one day does not silently ship an APK
                // those older devices cannot verify.
                enableV1Signing = true
                // v2 signs the whole file rather than entry by entry, so a
                // tampered zip fails before anything is read out of it.
                enableV2Signing = true
                // v3 carries a rotation lineage. Nothing is rotating today, but
                // it has to be present from the first signed build for a future
                // key change to be provable -- and the point of rotation is the
                // day this key is compromised, which is not a day to discover
                // the option needed to have been set years earlier. Older
                // devices ignore the v3 block and verify v2 as before.
                enableV3Signing = true
            }
        }
    }
    buildTypes {
        getByName("debug") {
            manifestPlaceholders["usesCleartextTraffic"] = "true"
            isDebuggable = true
            isJniDebuggable = true
            isMinifyEnabled = false
            packaging {                jniLibs.keepDebugSymbols.add("*/arm64-v8a/*.so")
                jniLibs.keepDebugSymbols.add("*/armeabi-v7a/*.so")
                jniLibs.keepDebugSymbols.add("*/x86/*.so")
                jniLibs.keepDebugSymbols.add("*/x86_64/*.so")
            }
        }
        getByName("release") {
            if (haveSigningKey) {
                signingConfig = signingConfigs.getByName("release")
            }
            isMinifyEnabled = true
            proguardFiles(
                *fileTree(".") { include("**/*.pro") }
                    .plus(getDefaultProguardFile("proguard-android-optimize.txt"))
                    .toList().toTypedArray()
            )
        }
    }
    kotlinOptions {
        jvmTarget = "1.8"
    }
    buildFeatures {
        buildConfig = true
    }
    // The bundled ffmpeg/ffprobe are executables, not libraries, and an
    // executable has to exist as a real file with the execute bit before it can
    // be spawned. AGP 8 defaults to leaving .so entries compressed inside the
    // APK and loading them straight from there, which works for something you
    // dlopen and is useless for something you exec. This forces them onto disk
    // in the native library directory -- the only place under an app's private
    // storage that Android 10 and later still allow execution from.
    //
    // The manifest's android:extractNativeLibs="true" says the same thing, but
    // AGP overwrites that attribute from this setting at merge time, so setting
    // only the manifest would be silently discarded.
    packaging {
        jniLibs {
            useLegacyPackaging = true
        }
    }
    // The bundled ffmpeg/ffprobe live outside `gen/`, which Tauri owns and
    // rewrites. Dropping them into app/src/main/jniLibs would work until the
    // next time the Android project is regenerated, and then fail as a missing
    // binary at runtime rather than as a build error.
    sourceSets.getByName("main").jniLibs.srcDir("../../../android-binaries")
}

rust {
    rootDirRel = "../../../"
}

dependencies {
    implementation("androidx.webkit:webkit:1.14.0")
    implementation("androidx.appcompat:appcompat:1.7.1")
    implementation("androidx.activity:activity-ktx:1.10.1")
    implementation("com.google.android.material:material:1.12.0")
    implementation("androidx.lifecycle:lifecycle-process:2.10.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.1.4")
    androidTestImplementation("androidx.test.espresso:espresso-core:3.5.0")
}

apply(from = "tauri.build.gradle.kts")