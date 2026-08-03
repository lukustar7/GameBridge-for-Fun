plugins {
    id("com.android.application")
}

// Android 包内版本直接读取仓库根目录 VERSION，避免与 Python 和发布说明各写一套数字。
val publicVersion = rootProject.projectDir.parentFile
    .resolve("VERSION")
    .readText()
    .trim()

// 正式签名只从进程环境读取。密钥、别名和口令不得写进 Gradle 文件或提交到仓库。
val releaseKeystorePath = providers.environmentVariable("GAME_BRIDGE_FOR_FUN_ANDROID_KEYSTORE").orNull
val releaseKeystorePassword = providers.environmentVariable("GAME_BRIDGE_FOR_FUN_ANDROID_KEYSTORE_PASSWORD").orNull
val releaseKeyAlias = providers.environmentVariable("GAME_BRIDGE_FOR_FUN_ANDROID_KEY_ALIAS").orNull
val releaseKeyPassword = providers.environmentVariable("GAME_BRIDGE_FOR_FUN_ANDROID_KEY_PASSWORD").orNull
val releaseSigningReady = listOf(
    releaseKeystorePath,
    releaseKeystorePassword,
    releaseKeyAlias,
    releaseKeyPassword,
).all { !it.isNullOrBlank() }

android {
    namespace = "app.gamebridgeforfun.mobile"
    compileSdk = 36
    compileSdkMinor = 1
    buildToolsVersion = "36.1.0"

    defaultConfig {
        applicationId = "app.gamebridgeforfun.mobile"
        minSdk = 35
        targetSdk = 36
        // versionCode 只负责 Android 升级顺序；公开显示统一使用上面的语义化版本。
        versionCode = 5
        versionName = publicVersion

        testInstrumentationRunner = "androidx.test.runner.AndroidJUnitRunner"
    }

    signingConfigs {
        if (releaseSigningReady) {
            create("release") {
                storeFile = file(releaseKeystorePath!!)
                storePassword = releaseKeystorePassword
                keyAlias = releaseKeyAlias
                keyPassword = releaseKeyPassword
            }
        }
    }

    buildTypes {
        release {
            // 第一版先保留完整符号，方便现场排查；正式商店发布前再单独评估压缩规则。
            isMinifyEnabled = false
            if (releaseSigningReady) {
                signingConfig = signingConfigs.getByName("release")
            }
            proguardFiles(
                getDefaultProguardFile("proguard-android-optimize.txt"),
                "proguard-rules.pro"
            )
        }
    }

    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_17
        targetCompatibility = JavaVersion.VERSION_17
    }

    buildFeatures {
        viewBinding = true
        buildConfig = true
    }
}

dependencies {
    implementation("com.google.android.material:material:1.14.0")

    testImplementation("junit:junit:4.13.2")
}
