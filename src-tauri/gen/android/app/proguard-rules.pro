# Add project specific ProGuard rules here.
# You can control the set of applied configuration files using the
# proguardFiles setting in build.gradle.
#
# For more details, see
#   http://developer.android.com/guide/developing/tools/proguard.html

# If your project uses WebView with JS, uncomment the following
# and specify the fully qualified class name to the JavaScript interface
# class:
#-keepclassmembers class fqcn.of.javascript.interface.for.webview {
#   public *;
#}

# Uncomment this to preserve the line number information for
# debugging stack traces.
#-keepattributes SourceFile,LineNumberTable

# If you keep the line number information, uncomment this to
# hide the original source file name.
#-renamesourcefileattribute SourceFile
# share.rs reaches MainActivity.shareFiles over raw JNI, which R8 cannot see —
# without this keep the method is stripped from release builds and the Rust
# side gets NoSuchMethodError (the Share button silently does nothing).
-keepclassmembers class com.iraslabs.facet.MainActivity {
    void shareFiles(java.lang.String[]);
}

# ThumbBridge.load is called only from Rust over JNI (thumbs.rs), so R8 sees
# no Java caller and strips it -- which surfaced on 2026-09-05 as
# NoSuchMethodError on every tile. Keep the class and its signature intact.
-keep class com.iraslabs.facet.ThumbBridge {
    public static byte[] load(android.content.Context, java.lang.String, int, boolean);
}

# MediaBridge is reached only from Rust over JNI (media.rs); same story.
-keep class com.iraslabs.facet.MediaBridge {
    public static void start(android.content.Context);
    public static java.lang.String pulse();
    public static java.lang.String query(android.content.Context, long, int);
    public static void scan(android.content.Context, java.lang.String);
}
