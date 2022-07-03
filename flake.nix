{
  description = "A very basic flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-22.05";
    utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, utils, ... }:
    utils.lib.eachDefaultSystem (system:
      let pkgs = nixpkgs.legacyPackages.${system};
          nodeEnv = self.packages.${system}.nodeEnv;
          nodeDeps = (import nodeEnv { inherit pkgs; }).nodeDependencies;
      in {
        packages = {
          # save on rebuilds with __contentAddressed
          srcsStripped = pkgs.runCommand "sources-stripped" {
            __contentAddressed = true;
            src = ./.;
          } ''
              mkdir $out
              cp -a $src/package.json $src/package-lock.json $out
          '';

          nodeEnv = pkgs.stdenv.mkDerivation {
            name = "node-env";
            src = self.packages.${system}.srcsStripped;
            buildInputs = with pkgs; [ nodejs sqlite node2nix ];

            buildPhase = ''
              node2nix -16 -l package-lock.json
            '';
            installPhase = ''
              mkdir $out
              cp package{,-lock}.json default.nix node-packages.nix node-env.nix $out
            '';
          };

          squawkbot = pkgs.stdenv.mkDerivation {
            name = "squawkbot";
            src = ./.;
            buildInputs = with pkgs; [ nodejs sqlite ];
            nativeBuildInputs = [ pkgs.makeWrapper ];

            buildPhase = ''
              ln -s ${nodeDeps}/lib/node_modules node_modules

              npm run build
            '';
            installPhase = ''
              mkdir -p $out/lib $out/bin
              cp -a dist node_modules $out/lib

              cat > $out/bin/squawkbot <<EOF
                #!/bin/sh
                node $out/lib/dist/index.js "$@"
              EOF
              chmod a+x $out/bin/squawkbot

              wrapProgram $out/bin/squawkbot \
                --set PATH ${pkgs.lib.makeBinPath (with pkgs; [
                  nodejs sqlite
                ])}
            '';
          };

          default = self.packages.${system}.squawkbot;
        };

        devShell = pkgs.mkShell {
          buildInputs = with pkgs; [ nodejs sqlite-interactive node2nix ];
        };
    });
}
