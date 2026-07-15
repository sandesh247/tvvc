import java.util.Properties

plugins {
  alias(libs.plugins.android.application)
  alias(libs.plugins.google.services)
  alias(libs.plugins.firebase.crashlytics)
}

val localProps = Properties().apply {
    rootProject.file("local.properties").takeIf { it.exists() }?.inputStream()?.use { load(it) }
}

android {
    namespace = "com.sandesh247.tvvc"
    compileSdk = 36

    val envProps = Properties().apply {
        file("../../web/.env").takeIf { it.exists() }?.inputStream()?.use { load(it) }
    }
    val databaseId = envProps.getProperty("VITE_FIRESTORE_DATABASE_ID", "default")
    val webAppUrl = envProps.getProperty("VITE_WEB_APP_URL", "https://gh-tvvc.web.app")

    val packageJsonFile = file("../../web/package.json")
    val packageVersionName = if (packageJsonFile.exists()) {
        val content = packageJsonFile.readText()
        val match = "\"version\"\\s*:\\s*\"([^\"]+)\"".toRegex().find(content)
        match?.groupValues?.get(1) ?: "1.0.0"
    } else {
        "1.0.0"
    }

    defaultConfig {
        applicationId = "com.sandesh247.tvvc"
        minSdk = 24
        targetSdk = 36
        versionCode = 42
        versionName = packageVersionName
        buildConfigField("String", "WEB_APP_URL", "\"$webAppUrl\"")
        buildConfigField("String", "FIRESTORE_DATABASE_ID", "\"$databaseId\"")
    }

    signingConfigs {
        create("release") {
            storeFile = file("release.keystore")
            storePassword = localProps.getProperty("RELEASE_STORE_PASSWORD", "")
            keyAlias = localProps.getProperty("RELEASE_KEY_ALIAS", "")
            keyPassword = localProps.getProperty("RELEASE_KEY_PASSWORD", "")
        }
    }

    buildTypes {
        release {
            isMinifyEnabled = false
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
            if (localProps.containsKey("RELEASE_STORE_PASSWORD")) {
                signingConfig = signingConfigs.getByName("release")
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }
    buildFeatures {
        buildConfig = true
    }

    packaging {
      resources {
        excludes += "/META-INF/{AL2.0,LGPL2.1}"
      }
    }
}

kotlin {
    jvmToolchain(17)
}

dependencies {
    // Core Android
    implementation(libs.androidx.core.ktx)
    implementation(libs.androidx.lifecycle.runtime.ktx)

    // Firebase
    implementation(platform(libs.firebase.bom))
    implementation(libs.firebase.messaging)
    implementation(libs.firebase.auth)
    implementation(libs.firebase.firestore)
    implementation(libs.firebase.crashlytics)

    // Tests
    testImplementation(libs.junit)
    androidTestImplementation(libs.androidx.test.core)
    androidTestImplementation(libs.androidx.test.ext.junit)
    androidTestImplementation(libs.androidx.test.runner)
    androidTestImplementation(libs.androidx.test.espresso.core)
}

tasks.register<Exec>("syncIcons") {
    val repoRoot = projectDir.parentFile.parentFile
    workingDir = repoRoot
    commandLine("node", "scripts/sync-icons.js")

    // Declare inputs and outputs for up-to-date checking and caching
    inputs.file(File(repoRoot, "web/public/favicon.png"))
    inputs.file(File(repoRoot, "scripts/sync-icons.js"))
    outputs.file(File(repoRoot, "android/app/src/main/res/mipmap-mdpi/ic_launcher.png"))
}

tasks.named("preBuild") {
    dependsOn("syncIcons")
}

