// Regenerate the golden canonical vectors. Run: cargo run --bin gen_vectors
// Output is deterministic; the `vectors` integration test asserts the committed file matches.
use std::io::Write;

fn main() {
    let out = "vectors/v1.json";
    let pretty = kaspa_forge_contracts::vectors::build_pretty();
    let mut f = std::fs::File::create(out).expect("create vectors file");
    f.write_all(pretty.as_bytes()).unwrap();
    f.write_all(b"\n").unwrap();
    println!("wrote {out}");
}
