{
  description = "Squawkbot";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-23.11";
    utils.url = "github:numtide/flake-utils";
  };

  outputs = { self, nixpkgs, utils, ... }:
    utils.lib.eachDefaultSystem (system:
      let
        pkgs = nixpkgs.legacyPackages.${system};

        deps = with pkgs; [ nodejs_21 deno sqlite ];

        nodeDeps = (import (self.packages.${system}.nodeEnv) {
          inherit pkgs;
        }).nodeDependencies;

      in {
        packages = {
          squawkbot = pkgs.buildNpmPackage {
            name = "squawkbot";
            src = ./.;
            npmDepsHash = "sha256-zLqr9pNHqgMsSfgU0H0b4q5YMlW+JmXfwND5G9xEUGk=";
            npmPackFlags = [ "--ignore-scripts" ];
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
