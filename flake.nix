{
  description = "A very basic flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-22.05";
    utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, utils, ... }:
    utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        nodeEnv = { nodeSrcs }:
          pkgs.stdenv.mkDerivation {
            name = "node-env";
            src = nodeSrcs;
            buildInputs = with pkgs; [ nodejs sqlite node2nix ];

            buildPhase = ''
              node2nix -16 -l package-lock.json
            '';
            installPhase = ''
              mkdir $out
              cp package{,-lock}.json default.nix node-packages.nix node-env.nix $out
            '';
          };

        nodeDeps = { nodeSrcs }:
          (import (nodeEnv { inherit nodeSrcs; }) {
            inherit pkgs;
          }).nodeDependencies;

        squawkbot = { nodeSrcs }:
          let nodeDepsOurs = nodeDeps { inherit nodeSrcs; };
          in pkgs.stdenv.mkDerivation {
            name = "squawkbot";
            src = ./.;
            buildInputs = with pkgs; [ nodejs sqlite ];
            nativeBuildInputs = [ pkgs.makeWrapper ];

            buildPhase = ''
              ln -s ${nodeDepsOurs}/lib/node_modules node_modules

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
                --set PATH ${
                  pkgs.lib.makeBinPath (with pkgs; [ nodejs sqlite ])
                }
            '';
          };

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

          nodeEnv = nodeEnv { nodeSrcs = self.packages.${system}.srcsStripped; };

          squawkbot =
            squawkbot { nodeSrcs = self.packages.${system}.srcsStripped; };

          # Colmena can't handle CA for some reason, even when it's
          # enabled system-wide
          squawkbotNoCA = squawkbot { nodeSrcs = ./.; };

          default = self.packages.${system}.squawkbot;
        };

        devShell = pkgs.mkShell {
          buildInputs = with pkgs; [ nodejs sqlite-interactive node2nix ];
        };

        formatter = pkgs.nixfmt;
      }) // {
        nixosModule = { config, lib, pkgs, ... }:
          with lib;
          let
            cfg = config.services.squawkbot;
            pkg = cfg.package;
            system = pkgs.stdenv.targetPlatform.system;
          in {
            options.services.squawkbot = {
              enable = mkEnableOption "enable the squawkbot service";

              envFile = mkOption {
                type = types.str;
                description = "Path to squawkbot's env file";
              };

              package = mkOption {
                type = types.package;
                description = "Which version of squawkbot are we using?";
                default = self.packages.${system}.squawkbot;
              };
            };

            config = mkIf cfg.enable {
              systemd.services.squawkbot = {
                wantedBy = [ "multi-user.target" ];
                after = [ "network.target" ];
                description = "squawkbot service";
                serviceConfig = {
                  Type = "simple";
                  Restart = "always";
                  RestartSec = "1";
                  ExecStart = "${pkg}/bin/squawkbot";
                  Environment = "DEBUG=squawk";
                  EnvironmentFile = cfg.envFile;
                  StateDirectory = "squawkbot";
                  WorkingDirectory = "/var/lib/squawkbot";
                };
              };
            };
          };
      };
}
