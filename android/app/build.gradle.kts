import org.jetbrains.kotlin.gradle.dsl.JvmTarget

fun quotedBuildValue(value: String): String = "\"" + value
    .replace("\\", "\\\\")
    .replace("\"", "\\\"") + "\""

plugins {
    id("com.android.application")
    id("org.jetbrains.kotlin.android")
}

android {
    namespace = "ai.beyondmarks.lyriclatch"
    compileSdk = 36

    defaultConfig {
        applicationId = "ai.beyondmarks.lyriclatch"
        minSdk = 28
        targetSdk = 36
        versionCode = 2
        versionName = "1.1.0"

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
        buildConfigField("String", "SPOTIFY_CLIENT_ID", quotedBuildValue(providers.environmentVariable("LYRICLATCH_SPOTIFY_CLIENT_ID").orElse("").get()))
        buildConfigField("String", "BACKEND_URL", quotedBuildValue(providers.environmentVariable("LYRICLATCH_BACKEND_URL").orElse("").get()))
        buildConfigField("String", "BACKEND_TOKEN", quotedBuildValue(providers.environmentVariable("LYRICLATCH_BACKEND_TOKEN").orElse("").get()))
    }

    buildTypes {
        release {
            isMinifyEnabled = true
            isShrinkResources = true
            proguardFiles(getDefaultProguardFile("proguard-android-optimize.txt"), "proguard-rules.pro")
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    packaging {
        resources.excludes += setOf("META-INF/DEPENDENCIES", "META-INF/LICENSE*", "META-INF/NOTICE*")
    }

    buildFeatures {
        buildConfig = true
    }
}

kotlin {
    compilerOptions {
        jvmTarget.set(JvmTarget.JVM_17)
    }
}

dependencies {
    implementation(files("libs/spotify-app-remote-release-0.8.0.aar"))
    implementation("com.google.code.gson:gson:2.14.0")
    implementation("com.microsoft.onnxruntime:onnxruntime-android:1.29.0")
    testImplementation("junit:junit:4.13.2")
    androidTestImplementation("androidx.test.ext:junit:1.3.0")
    androidTestImplementation("androidx.test:runner:1.7.0")
}
