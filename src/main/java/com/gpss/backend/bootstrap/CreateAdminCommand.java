package com.gpss.backend.bootstrap;

import java.util.Scanner;

import org.springframework.boot.ApplicationArguments;
import org.springframework.boot.ApplicationRunner;
import org.springframework.boot.SpringApplication;
import org.springframework.context.ApplicationContext;
import org.springframework.stereotype.Component;

import com.gpss.backend.auth.application.AuthService;
import com.gpss.backend.auth.domain.UserRole;
import com.gpss.backend.auth.web.CreateUserRequest;

@Component
public class CreateAdminCommand implements ApplicationRunner {

    private final AuthService authService;
    private final ApplicationContext context;

    public CreateAdminCommand(AuthService authService, ApplicationContext context) {
        this.authService = authService;
        this.context = context;
    }

    @Override
    public void run(ApplicationArguments args) {
        if (!args.containsOption("create-admin") && !args.getNonOptionArgs().contains("--create-admin")) {
            return;
        }
        Scanner scanner = new Scanner(System.in);
        System.out.print("Administrator employee ID: ");
        String employeeId = scanner.nextLine().strip().toUpperCase();
        System.out.print("Administrator name: ");
        String name = scanner.nextLine().strip();
        System.out.print("Administrator email: ");
        String email = scanner.nextLine().strip().toLowerCase();
        System.out.print("Administrator password (12+ characters): ");
        String password = scanner.nextLine();
        CreateUserRequest request = new CreateUserRequest(employeeId, name, email, password, UserRole.ADMIN);
        authService.createUser(request, true);
        System.out.println("Created administrator " + employeeId + ".");
        System.exit(SpringApplication.exit(context, () -> 0));
    }
}
