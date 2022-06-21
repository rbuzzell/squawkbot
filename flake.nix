{
  description = "A very basic flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-22.05";
    utils.url = "github:numtide/flake-utils";
  };

  outputs = { nixpkgs, utils, ... }:
    utils.lib.eachDefaultSystem (system:
      let pkgs = nixpkgs.legacyPackages.${system};
      in {
        # packages.x86_64-linux.squawkbot = { };

        # defaultPackage.x86_64-linux = self.packages.x86_64-linux.squawkbot;

        devShell = pkgs.mkShell {
          buildInputs = [ pkgs.nodejs ];
        };
    });
}
