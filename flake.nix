{
  description = "A very basic flake";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-22.11";
    utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, utils, ... }:
    utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        deps = with pkgs; [ nodejs-18_x sqlite ];

        nodeDeps = (import (self.packages.${system}.nodeEnv) {
          inherit pkgs;
        }).nodeDependencies;

      in {
        packages = {
          srcsStripped = pkgs.runCommand "sources-stripped" { } ''
            mkdir $out
            ln -s ${./package.json} $out/package.json
            ln -s ${./package-lock.json} $out/package-lock.json
          '';

          nodeEnv = pkgs.stdenv.mkDerivation {
            name = "node-env";
            src = self.packages.${system}.srcsStripped;
            buildInputs = deps ++ [ pkgs.node2nix ];

            buildPhase = ''
              # WARNING: the node version and node2nix's mode must
              # match, or else you will get mysterious symbol errors

              node2nix -18 -l package-lock.json
            '';
            installPhase = ''
              mkdir $out
              cp package{,-lock}.json default.nix node-packages.nix node-env.nix $out
            '';
          };

          squawkbot = pkgs.stdenv.mkDerivation {
            name = "squawkbot";
            src = ./.;
            buildInputs = deps;
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
                --set PATH ${pkgs.lib.makeBinPath deps} \
                --set LD_LIBRARY_PATH ${pkgs.lib.makeLibraryPath deps}
            '';
          };

          default = self.packages.${system}.squawkbot;
        };

        devShell = pkgs.mkShell {
          buildInputs = with pkgs; deps ++ [ sqlite-interactive node2nix ];
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
