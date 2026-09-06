// Release builds must not attach a console window — FACET is meant to appear
// with no terminal behind it. Debug keeps the console for logs.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    facet_lib::run()
}
