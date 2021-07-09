extern crate dotenv;

use dotenv::dotenv;
use std::env;

fn main() {
    println!("Hello, world!");
    print_env();
}

fn print_env(){
    dotenv().ok();

    for (key, value) in env::vars() {
        println!("{}: {}", key, value);
    }
}
